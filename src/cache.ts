/**
 * Read cache for captured configs.
 *
 * Note the Cache API silently does nothing on a workers.dev subdomain. Every put
 * succeeds and every match misses, so a custom domain is needed for this to have any
 * effect at all. See the README.
 */

async function hash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key includes the API key, so two callers using different UniFi keys never share a
 * cached response even when they ask about the same console id.
 */
async function cacheKey(apiKey: string, parts: string[]): Promise<Request> {
  const h = await hash([apiKey, ...parts].join("|"));
  return new Request(`https://mcp-unifi.internal/cache/${h}`);
}

export async function cachedJson<T>(
  apiKey: string,
  parts: string[],
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  const key = await cacheKey(apiKey, parts);
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as T;

  const value = await produce();
  await cache.put(
    key,
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
    }),
  );
  return value;
}
