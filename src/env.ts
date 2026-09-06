export interface Env {
  /** Optional. Omit to run in bring-your-own-key mode. */
  UNIFI_API_KEY?: string;
  /** Required whenever UNIFI_API_KEY is set. Comma separated list for rotation. */
  MCP_TOKEN?: string;
  /** Optional comma separated allowlist of console IDs. Secret, not a var. */
  ALLOWED_CONSOLES?: string;
  ENABLE_WRITES?: string;
  MAX_BATCH?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

export function writesEnabled(env: Env): boolean {
  return (env.ENABLE_WRITES ?? "false").toLowerCase() === "true";
}

export function maxBatch(env: Env): number {
  const n = Number(env.MAX_BATCH ?? "6");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 6;
}

export function upstreamTimeoutMs(env: Env): number {
  const n = Number(env.UPSTREAM_TIMEOUT_MS ?? "15000");
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/**
 * Returns null when no allowlist is configured, meaning every console the key can see.
 * An empty allowlist is treated as a configuration mistake rather than as "allow none",
 * because silently returning nothing is much harder to debug than an explicit error.
 */
export function allowedConsoles(env: Env): Set<string> | null {
  if (!env.ALLOWED_CONSOLES) return null;
  const ids = env.ALLOWED_CONSOLES.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}
