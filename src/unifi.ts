import { upstreamTimeoutMs, type Env } from "./env";

const SITE_MANAGER_BASE = "https://api.ui.com/v1";

/**
 * Minimum console firmware for the Cloud Connector proxy. Below this the console simply
 * is not reachable from the cloud at all, and the failure surfaces as a confusing 404
 * rather than as anything about firmware, so we check it ourselves.
 */
export const MIN_CONNECTOR_FIRMWARE = "5.0.3";

export class UnifiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly consoleId?: string,
  ) {
    super(message);
  }
}

export interface ConsoleSummary {
  consoleId: string;
  name: string;
  model: string;
  osVersion: string;
  ipAddress: string | null;
  online: boolean;
  connectorCapable: boolean;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Turns an upstream status into something that names the likely cause. */
function explain(status: number, body: string, consoleId?: string): string {
  switch (status) {
    case 401:
      return "UniFi rejected the API key. Check the key is current and was generated at unifi.ui.com rather than on a single console.";
    case 403:
      return consoleId
        ? `The API key cannot reach console ${consoleId}. A personal key only reaches consoles owned by the key's owner, so an organisation key is needed to manage other admins' consoles.`
        : "The API key lacks permission for this call.";
    case 404:
      return consoleId
        ? `Console ${consoleId} was not found, or its firmware predates ${MIN_CONNECTOR_FIRMWARE} and so has no Cloud Connector proxy. Run verify_console to tell those two apart.`
        : "Endpoint not found. If this came from raw_request, check the path against developer.ui.com.";
    case 429:
      return "Rate limited by UniFi. Reduce the batch size or wait for the interval given in the Retry-After header.";
    case 502:
    case 503:
    case 504:
      return consoleId
        ? `Console ${consoleId} did not answer through the cloud proxy. It is most likely offline or its uplink is down.`
        : "UniFi cloud is not responding.";
    default:
      return `UniFi returned ${status}. ${body.slice(0, 300)}`;
  }
}

export class UnifiClient {
  constructor(
    private readonly apiKey: string,
    private readonly env: Env,
  ) {}

  private async request(url: string, init: RequestInit, consoleId?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs(this.env));
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "X-API-KEY": this.apiKey,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new UnifiError(
        aborted
          ? `Timed out waiting for ${consoleId ?? "UniFi"}. Proxied calls add roughly 800ms each, so a slow console can exceed the limit.`
          : `Network failure calling UniFi: ${String(err)}`,
        aborted ? 504 : 502,
        consoleId,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) throw new UnifiError(explain(res.status, text, consoleId), res.status, consoleId);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UnifiError("UniFi returned a body that was not JSON.", 502, consoleId);
    }
  }

  /** Site Manager cloud API. Fleet level, read only. */
  async siteManager(path: string): Promise<unknown> {
    return this.request(`${SITE_MANAGER_BASE}${path}`, { method: "GET" });
  }

  /**
   * Rejects a proxy path that could escape the intended console prefix or redirect the
   * request somewhere else.
   *
   * The path is concatenated into the connector URL, so without this a caller could walk
   * out of /proxy with .. segments, or start a protocol-relative or absolute URL and have
   * the request go to a host of their choosing. Encoded forms are caught too, because the
   * cloud endpoint decodes before forwarding.
   */
  private static assertSafePath(path: string): void {
    const reject = (reason: string): never => {
      throw new UnifiError(`Rejected proxy path: ${reason}. Give a path relative to the console's /proxy prefix, for example /network/integration/v1/sites.`, 400);
    };

    if (!path.startsWith("/")) reject("it must begin with a single slash");
    // Two leading slashes are read as protocol-relative and would change the host.
    if (path.startsWith("//")) reject("a protocol-relative path would change the target host");
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) reject("an absolute URL would change the target host");
    if (path.includes("\\")) reject("backslashes are not allowed");
    if (/[\s\x00-\x1f]/.test(path)) reject("whitespace and control characters are not allowed");

    // Decode repeatedly, since a single decode still leaves %252e%252e as ..
    let decoded = path;
    for (let i = 0; i < 3; i++) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        reject("it contains a malformed percent-encoded sequence");
        return;
      }
      if (next === decoded) break;
      decoded = next;
    }

    if (decoded.split(/[/?#]/).includes("..")) reject("parent directory segments are not allowed");
  }

  /**
   * Cloud Connector proxy. Forwards to the console's own local API without needing a
   * VPN or an open port. The path is whatever the console serves under /proxy, which is
   * why both the official integration API and the classic API are reachable this way.
   */
  async proxy(
    consoleId: string,
    method: string,
    proxyPath: string,
    body?: unknown,
  ): Promise<unknown> {
    const clean = proxyPath.startsWith("/") ? proxyPath : `/${proxyPath}`;
    UnifiClient.assertSafePath(clean);
    return this.request(
      `${SITE_MANAGER_BASE}/connector/consoles/${encodeURIComponent(consoleId)}/proxy${clean}`,
      { method, body: body === undefined ? undefined : JSON.stringify(body) },
      consoleId,
    );
  }

  async listConsoles(): Promise<ConsoleSummary[]> {
    const raw = (await this.siteManager("/hosts")) as { data?: unknown[] } | null;
    const hosts = Array.isArray(raw?.data) ? raw!.data : [];
    return hosts.map((h) => {
      const host = h as Record<string, any>;
      const reported = (host.reportedState ?? {}) as Record<string, any>;
      const osVersion = String(reported.version ?? reported.controller_uuid ?? "0.0.0");
      return {
        consoleId: String(host.id ?? ""),
        name: String(reported.hostname ?? reported.name ?? host.id ?? "unknown"),
        model: String(reported.hardware?.shortname ?? reported.hardware?.name ?? "unknown"),
        osVersion,
        ipAddress: host.ipAddress ? String(host.ipAddress) : null,
        online: reported.state === "connected" || host.isBlocked === false,
        connectorCapable: compareVersions(osVersion, MIN_CONNECTOR_FIRMWARE) >= 0,
      };
    });
  }

  /** The classic API wraps everything in a meta/data envelope. Unwrap it once, here. */
  static unwrap(payload: unknown): unknown[] {
    const p = payload as { meta?: { rc?: string; msg?: string }; data?: unknown } | null;
    if (p && typeof p === "object" && "meta" in p) {
      if (p.meta?.rc === "error") {
        throw new UnifiError(`Console rejected the request: ${p.meta.msg ?? "unknown"}`, 400);
      }
      return Array.isArray(p.data) ? p.data : p.data ? [p.data] : [];
    }
    // The official integration API returns { data: [...] } with no meta.
    const d = (payload as { data?: unknown })?.data;
    if (Array.isArray(d)) return d;
    return Array.isArray(payload) ? payload : payload ? [payload] : [];
  }
}
