import { UnifiClient, UnifiError } from "./unifi";
import {
  normaliseDns,
  normaliseFirewall,
  normaliseNetworks,
  normaliseWifi,
  type NormalisedConfig,
  type SectionName,
} from "./normalise";

/**
 * Everything is read from the official Network Integration API, reached through the
 * Cloud Connector proxy. The classic controller API is not used at all: v10.4.57 exposes
 * networks, WiFi, firewall zones and policies, ACL rules and DNS policies officially, so
 * there is no reason to take on session cookies and undocumented field names.
 */
const NET = "/network/integration/v1";

export const SECTIONS: SectionName[] = ["networks", "wifi", "firewall", "dns"];

/** Page size for list endpoints. Deliberately modest: these are config objects, not clients. */
const PAGE_LIMIT = 200;

/**
 * The list endpoint for networks returns a summary only: name, VLAN, enabled, zone and
 * origin. Subnet, DHCP scope, isolation, mDNS forwarding and internet access exist only
 * on GET /networks/{id}. Diffing the summary alone silently compares null against null
 * and reports two sites as identical when their addressing differs completely, so each
 * network is fetched individually.
 *
 * That costs one subrequest per network. Workers caps subrequests per request (50 on the
 * free plan) and diff_config fans out across several consoles inside a single request, so
 * the cap below is a real limit rather than a formality. Exceeding it fails loudly.
 */
const NETWORK_DETAIL_LIMIT = 25;

/** Fetches network detail a few at a time: serial is slow enough to risk the timeout. */
const DETAIL_CONCURRENCY = 4;

/**
 * Fetches one paginated list endpoint. The envelope is
 * { offset, limit, count, totalCount, data }, and a single page covers any realistic
 * config object count, so this reads one page and reports if more exist rather than
 * looping and burning subrequests.
 */
async function listAll(
  client: UnifiClient,
  consoleId: string,
  path: string,
): Promise<Record<string, any>[]> {
  const payload = (await client.proxy(
    consoleId,
    "GET",
    `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE_LIMIT}`,
  )) as Record<string, any> | null;

  const data = Array.isArray(payload?.data) ? payload!.data : [];
  const total = Number(payload?.totalCount ?? data.length);
  if (total > data.length) {
    throw new UnifiError(
      `Console ${consoleId} has ${total} entries at ${path} but only ${data.length} were read. Raise PAGE_LIMIT or add paging before trusting a diff of this section.`,
      500,
      consoleId,
    );
  }
  return data;
}

/**
 * Expands summary rows into full objects via their per-id endpoint.
 *
 * A network whose detail call fails is not silently downgraded to its summary, because
 * that would reintroduce the null-versus-null comparison this exists to prevent. The
 * whole capture fails instead, naming the network.
 */
async function fetchDetails(
  client: UnifiClient,
  consoleId: string,
  base: string,
  rows: Record<string, any>[],
): Promise<Record<string, any>[]> {
  if (rows.length > NETWORK_DETAIL_LIMIT) {
    throw new UnifiError(
      `Console ${consoleId} has ${rows.length} networks, above the ${NETWORK_DETAIL_LIMIT} this server will expand in one call. Each network costs a subrequest and Workers caps those per request. Diff a different section, or raise NETWORK_DETAIL_LIMIT and reduce MAX_BATCH together.`,
      507,
      consoleId,
    );
  }

  const out: Record<string, any>[] = [];
  for (let i = 0; i < rows.length; i += DETAIL_CONCURRENCY) {
    const slice = rows.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (row) => {
        if (!row.id) return row;
        const detail = (await client.proxy(
          consoleId,
          "GET",
          `${base}/networks/${encodeURIComponent(String(row.id))}`,
        )) as Record<string, any> | null;
        if (!detail) {
          throw new UnifiError(
            `Console ${consoleId} returned no detail for network "${row.name ?? row.id}".`,
            502,
            consoleId,
          );
        }
        return detail;
      }),
    );
    out.push(...settled);
  }
  return out;
}

/** Resolves the site to operate on. Errors rather than guessing when a console has several. */
async function resolveSite(client: UnifiClient, consoleId: string): Promise<string> {
  const sites = await listAll(client, consoleId, `${NET}/sites`);
  if (!sites.length) throw new UnifiError(`Console ${consoleId} reported no sites.`, 404, consoleId);
  if (sites.length > 1) {
    const names = sites.map((s) => `${s.name ?? "unnamed"} (${s.id})`).join(", ");
    throw new UnifiError(
      `Console ${consoleId} hosts ${sites.length} sites: ${names}. Multi-site consoles are not handled yet, so pick one explicitly with raw_request.`,
      409,
      consoleId,
    );
  }
  return String(sites[0].id);
}

async function applicationVersion(client: UnifiClient, consoleId: string): Promise<string | null> {
  try {
    const info = (await client.proxy(consoleId, "GET", `${NET}/info`)) as Record<string, any> | null;
    return info?.applicationVersion ? String(info.applicationVersion) : null;
  } catch {
    // Version is useful context but never worth failing a capture over.
    return null;
  }
}

export async function captureConfig(
  client: UnifiClient,
  consoleId: string,
  sections: SectionName[],
  meta: { model: string; osVersion: string },
): Promise<NormalisedConfig> {
  const siteId = await resolveSite(client, consoleId);
  const base = `${NET}/sites/${siteId}`;

  const wantsNetworks = sections.includes("networks");
  const wantsFirewall = sections.includes("firewall");
  // WiFi resolves its bridged network to a name, so it needs the summary list too.
  const needsNetworkList = wantsNetworks || wantsFirewall || sections.includes("wifi");

  const networkRows = needsNetworkList ? await listAll(client, consoleId, `${base}/networks`) : [];

  /**
   * Zones are enrichment for networks (a network gets its zone's name) but structural for
   * firewall (there is nothing to report without them). A console without zone-based
   * firewalling configured returns 400 here, which previously took the networks section
   * down with it even though networks itself was perfectly readable.
   */
  let zoneRows: Record<string, any>[] = [];
  let zoneError: string | null = null;
  if (wantsNetworks || wantsFirewall) {
    try {
      zoneRows = await listAll(client, consoleId, `${base}/firewall/zones`);
    } catch (err) {
      zoneError = err instanceof Error ? err.message : String(err);
      if (wantsFirewall) throw err;
    }
  }

  const networksById = new Map<string, string>();
  for (const n of networkRows) {
    if (n.id && n.name) networksById.set(String(n.id), String(n.name));
  }
  const zonesById = new Map<string, string>();
  for (const z of zoneRows) {
    if (z.id && z.name) zonesById.set(String(z.id), String(z.name));
  }

  const out: NormalisedConfig = {
    meta: {
      consoleId,
      siteId,
      model: meta.model,
      osVersion: meta.osVersion,
      networkApiVersion: await applicationVersion(client, consoleId),
      capturedAt: new Date().toISOString(),
    },
    sections: {},
  };

  if (wantsNetworks) {
    const detailed = await fetchDetails(client, consoleId, base, networkRows);
    out.sections.networks = normaliseNetworks(detailed, zonesById);
    if (zoneError) {
      // Surfaced rather than swallowed: zoneRef will be null on every network, and a
      // diff against a console that does have zones would otherwise look like real drift.
      out.meta.warnings = [
        `Firewall zones could not be read, so every network's zoneRef is null and zone drift cannot be detected. Cause: ${zoneError}`,
      ];
    }
  }

  if (sections.includes("wifi")) {
    const rows = await listAll(client, consoleId, `${base}/wifi/broadcasts`);
    out.sections.wifi = normaliseWifi(rows, networksById);
  }

  if (wantsFirewall) {
    const policies = await listAll(client, consoleId, `${base}/firewall/policies`);
    out.sections.firewall = normaliseFirewall(zoneRows, policies, networksById);
  }

  if (sections.includes("dns")) {
    const rows = await listAll(client, consoleId, `${base}/dns/policies`);
    out.sections.dns = normaliseDns(rows);
  }

  return out;
}
