import type { Env } from "./env";

// Claude's connector UI greys out the authorization header because it reserves it for
// OAuth, so x-api-key is the one that actually gets used in practice. The rest are here
// because other MCP clients each picked a different convention.
const HEADER_ORDER = [
  "authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-apikey",
  "x-api-token",
  "api-token",
  "x-auth-token",
];

export interface AuthResult {
  ok: boolean;
  /** The key to present to UniFi as X-API-KEY. */
  upstreamKey?: string;
  status?: number;
  message?: string;
}

/** Constant time compare. No early exit, so a wrong token cannot be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Length is folded into the difference rather than branched on, so mismatched lengths
  // still walk the full loop below.
  let diff = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function presentedCredential(req: Request): string | null {
  for (const name of HEADER_ORDER) {
    const raw = req.headers.get(name);
    if (!raw) continue;
    const value = name === "authorization" ? raw.replace(/^Bearer\s+/i, "").trim() : raw.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Two modes:
 *
 * Bring your own key. No UNIFI_API_KEY set, so whatever the caller presents IS the UniFi
 * key. The deployment holds no credentials and is safe to share publicly.
 *
 * Server key. UNIFI_API_KEY is set, so the caller's credential is checked against
 * MCP_TOKEN. If MCP_TOKEN is missing we refuse to serve entirely rather than quietly
 * handing the whole fleet to anyone who finds the URL.
 */
export function authenticate(req: Request, env: Env, urlToken: string | null): AuthResult {
  const presented = presentedCredential(req) ?? urlToken;

  if (!env.UNIFI_API_KEY) {
    if (!presented) {
      return {
        ok: false,
        status: 401,
        message:
          "No credential presented. This deployment runs in bring-your-own-key mode, so send your UniFi API key as the x-api-key header.",
      };
    }
    return { ok: true, upstreamKey: presented };
  }

  if (!env.MCP_TOKEN) {
    return {
      ok: false,
      status: 500,
      message:
        "UNIFI_API_KEY is set but MCP_TOKEN is not. Refusing to serve, because that combination would expose the fleet to any unauthenticated caller. Set MCP_TOKEN as a secret.",
    };
  }

  if (!presented) {
    return { ok: false, status: 401, message: "No credential presented. Send it as the x-api-key header." };
  }

  // Comma separated so a new token can be added, clients migrated, then the old one
  // removed, without a flag day.
  const accepted = env.MCP_TOKEN.split(",").map((t) => t.trim()).filter(Boolean);
  let matched = false;
  for (const candidate of accepted) {
    // No break, so total work does not depend on which token matched.
    if (timingSafeEqual(candidate, presented)) matched = true;
  }

  if (!matched) return { ok: false, status: 401, message: "Credential rejected." };
  return { ok: true, upstreamKey: env.UNIFI_API_KEY };
}

/**
 * Deliberately no WWW-Authenticate header. MCP clients treat it as advertising OAuth and
 * then prompt the user for a sign-in flow that does not exist here.
 */
export function unauthorised(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
