import { UnifiClient, UnifiError } from "./unifi";

/**
 * Operational state, as opposed to configuration.
 *
 * Config answers "is this site built the way we build sites". State answers "is this site
 * healthy right now". They come from different places: config from the official Network
 * Integration API, state from the classic controller API, which is still where health,
 * device status and ISP metrics live in v10.
 *
 * Everything here reduces hard. The raw stat/device payload for a four device site is
 * large enough to exhaust an LLM context window on its own, so no tool passes it through.
 */

const CLASSIC = "/network/api";

/** Guards against a payload that would swamp the caller. */
const MAX_RESPONSE_BYTES = 200_000;

export interface WanMonitor {
  target: string;
  type: string;
  availabilityPercent: number | null;
  latencyMs: number | null;
}

export interface WanState {
  name: string;
  availabilityPercent: number | null;
  latencyAverageMs: number | null;
  uptimeSeconds: number | null;
  downtimeSeconds: number | null;
  monitors: WanMonitor[];
}

export interface HealthState {
  consoleId: string;
  consoleName: string;
  status: "ok" | "warning" | "error" | "unknown";
  isp: { name: string | null; organisation: string | null; asn: number | null };
  wanIp: string | null;
  wans: WanState[];
  internetLatencyMs: number | null;
  clients: { total: number; wireless: number; guest: number; wired: number };
  devices: { access_points: number; switches: number; gateways: number; disconnected: number; pending: number };
  gateway: { name: string | null; version: string | null; cpuPercent: number | null; memoryPercent: number | null; uptimeSeconds: number | null };
  subsystems: Record<string, string>;
}

export interface DeviceState {
  name: string;
  model: string | null;
  type: string | null;
  mac: string | null;
  ipAddress: string | null;
  version: string | null;
  /** UniFi's own experience score, 0 to 100. Null on gateways, which do not report one. */
  satisfaction: number | null;
  upgradable: boolean;
  adopted: boolean;
  /** Classic API state: 1 is connected. Anything else needs attention. */
  connected: boolean;
  uptimeSeconds: number | null;
  clientCount: number | null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The classic API is addressed by site name, not the UUID the integration API uses, and
 * the name is not always "default" on a console that has been renamed or migrated.
 */
export async function resolveClassicSite(client: UnifiClient, consoleId: string): Promise<string> {
  const payload = await client.proxy(consoleId, "GET", `${CLASSIC}/self/sites`);
  const sites = UnifiClient.unwrap(payload) as Record<string, any>[];
  if (!sites.length) throw new UnifiError(`Console ${consoleId} reported no classic sites.`, 404, consoleId);
  if (sites.length > 1) {
    const names = sites.map((s) => `${s.desc ?? s.name} (${s.name})`).join(", ");
    throw new UnifiError(
      `Console ${consoleId} hosts several sites: ${names}. State tools handle one site per console; use raw_request to target a specific one.`,
      409,
      consoleId,
    );
  }
  return String(sites[0].name ?? "default");
}

function normaliseWans(uptimeStats: Record<string, any> | null | undefined): WanState[] {
  if (!uptimeStats) return [];
  return Object.entries(uptimeStats)
    .map(([name, raw]) => {
      const wan = raw as Record<string, any>;
      return {
        name,
        availabilityPercent: num(wan.availability),
        latencyAverageMs: num(wan.latency_average),
        uptimeSeconds: num(wan.uptime),
        downtimeSeconds: num(wan.downtime),
        monitors: Array.isArray(wan.monitors)
          ? wan.monitors.map((m: Record<string, any>) => ({
              target: String(m.target ?? "unknown"),
              type: String(m.type ?? "unknown"),
              availabilityPercent: num(m.availability),
              latencyMs: num(m.latency_average),
            }))
          : [],
      };
    })
    /**
     * A WAN port that has never carried traffic reports 0% availability and days of
     * downtime forever. On a single-WAN site that is every secondary port, so leaving
     * them in means four blocks of meaningless JSON per site and a false alarm on any
     * check that looks at availability across all WANs.
     */
    .filter((wan) => wan.uptimeSeconds !== null || (wan.availabilityPercent ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function captureHealth(
  client: UnifiClient,
  consoleId: string,
  consoleName: string,
): Promise<HealthState> {
  const site = await resolveClassicSite(client, consoleId);
  const payload = await client.proxy(consoleId, "GET", `${CLASSIC}/s/${site}/stat/health`);
  const rows = UnifiClient.unwrap(payload) as Record<string, any>[];

  const bySubsystem = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if (row.subsystem) bySubsystem.set(String(row.subsystem), row);
  }

  const wlan = bySubsystem.get("wlan") ?? {};
  const wan = bySubsystem.get("wan") ?? {};
  const lan = bySubsystem.get("lan") ?? {};
  const www = bySubsystem.get("www") ?? {};

  const subsystems: Record<string, string> = {};
  for (const [name, row] of bySubsystem) subsystems[name] = String(row.status ?? "unknown");

  // Worst subsystem status wins, ignoring "unknown" so an unconfigured VPN does not
  // downgrade an otherwise healthy site.
  const statuses = Object.values(subsystems).filter((s) => s !== "unknown");
  const status = statuses.includes("error")
    ? "error"
    : statuses.includes("warning")
      ? "warning"
      : statuses.length
        ? "ok"
        : "unknown";

  const gwStats = (wan.gw_system_stats ?? wan["gw_system-stats"] ?? {}) as Record<string, any>;

  return {
    consoleId,
    consoleName,
    status: status as HealthState["status"],
    isp: {
      name: wan.isp_name ?? null,
      organisation: wan.isp_organization ?? null,
      asn: num(wan.asn),
    },
    wanIp: wan.wan_ip ?? null,
    wans: normaliseWans(wan.uptime_stats),
    internetLatencyMs: num(www.latency),
    clients: {
      total: (num(wan.num_sta) ?? 0),
      wireless: (num(wlan.num_user) ?? 0) + (num(wlan.num_guest) ?? 0),
      guest: num(wlan.num_guest) ?? 0,
      wired: num(lan.num_user) ?? 0,
    },
    devices: {
      access_points: num(wlan.num_ap) ?? 0,
      switches: num(lan.num_sw) ?? 0,
      gateways: num(wan.num_gw) ?? 0,
      disconnected:
        (num(wlan.num_disconnected) ?? 0) + (num(lan.num_disconnected) ?? 0) + (num(wan.num_disconnected) ?? 0),
      pending: (num(wlan.num_pending) ?? 0) + (num(lan.num_pending) ?? 0) + (num(wan.num_pending) ?? 0),
    },
    gateway: {
      name: wan.gw_name ?? null,
      version: wan.gw_version ?? null,
      cpuPercent: num(gwStats.cpu),
      memoryPercent: num(gwStats.mem),
      uptimeSeconds: num(gwStats.uptime),
    },
    subsystems,
  };
}

export interface ClientState {
  name: string;
  mac: string | null;
  ipAddress: string | null;
  network: string | null;
  wired: boolean;
  guest: boolean;
  ssid: string | null;
  accessPoint: string | null;
  band: string | null;
  signalDbm: number | null;
  /** UniFi's per-client experience score, 0 to 100. */
  satisfaction: number | null;
  /** Percentage of WiFi transmissions that needed retrying. Above ~20% is poor. */
  txRetryPercent: number | null;
  uptimeSeconds: number | null;
}

/** Radio codes as returned by the classic API. */
const BANDS: Record<string, string> = { ng: "2.4GHz", na: "5GHz", "6e": "6GHz", ax: "5GHz" };

export async function captureClients(
  client: UnifiClient,
  consoleId: string,
): Promise<ClientState[]> {
  const site = await resolveClassicSite(client, consoleId);
  const payload = await client.proxy(consoleId, "GET", `${CLASSIC}/s/${site}/stat/sta`);

  const size = JSON.stringify(payload).length;
  if (size > MAX_RESPONSE_BYTES) {
    throw new UnifiError(
      `Console ${consoleId} returned ${Math.round(size / 1024)}KB of client data, above the ${Math.round(MAX_RESPONSE_BYTES / 1024)}KB guard. Too many clients to reduce safely in one call.`,
      507,
      consoleId,
    );
  }

  const rows = UnifiClient.unwrap(payload) as Record<string, any>[];

  return rows
    .map((row) => {
      const wired = row.is_wired === true;
      return {
        // Hostnames are often absent on IoT kit, so fall back to the vendor then the MAC.
        name: String(row.name ?? row.hostname ?? row.oui ?? row.mac ?? "(unknown)"),
        mac: row.mac ? String(row.mac) : null,
        ipAddress: row.ip ?? row.last_ip ?? null,
        network: row.network ?? row.last_connection_network_name ?? null,
        wired,
        guest: row.is_guest === true,
        ssid: wired ? null : (row.essid ?? null),
        accessPoint: row.last_uplink_name ?? null,
        band: wired ? null : (BANDS[String(row.radio_proto ?? row.radio ?? "")] ?? null),
        signalDbm: wired ? null : num(row.signal),
        satisfaction: num(row.satisfaction),
        txRetryPercent: wired ? null : num(row.wifi_tx_retries_percentage),
        uptimeSeconds: num(row.uptime),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function captureDevices(
  client: UnifiClient,
  consoleId: string,
): Promise<DeviceState[]> {
  const site = await resolveClassicSite(client, consoleId);
  const payload = await client.proxy(consoleId, "GET", `${CLASSIC}/s/${site}/stat/device`);

  // stat/device returns port tables, radio tables and per-client stats. A four device
  // site is already large enough to exhaust a context window, so this is checked before
  // anything tries to hold it all.
  const size = JSON.stringify(payload).length;
  if (size > MAX_RESPONSE_BYTES) {
    throw new UnifiError(
      `Console ${consoleId} returned ${Math.round(size / 1024)}KB of device data, above the ${Math.round(MAX_RESPONSE_BYTES / 1024)}KB guard. This site has more devices than this tool reduces safely; use raw_request against a narrower path.`,
      507,
      consoleId,
    );
  }

  const rows = UnifiClient.unwrap(payload) as Record<string, any>[];

  return rows
    .map((row) => ({
      name: String(row.name ?? row.mac ?? "(unnamed)"),
      model: row.model ? String(row.model) : null,
      type: row.type ? String(row.type) : null,
      mac: row.mac ? String(row.mac) : null,
      ipAddress: row.ip ? String(row.ip) : null,
      version: row.version ? String(row.version) : null,
      satisfaction: num(row.satisfaction),
      upgradable: row.upgradable === true,
      adopted: row.adopted !== false,
      connected: num(row.state) === 1,
      uptimeSeconds: num(row.uptime),
      clientCount: num(row["num_sta"]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
