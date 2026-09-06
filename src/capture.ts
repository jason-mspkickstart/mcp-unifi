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

  // Networks and zones underpin the other sections: WiFi references a network, and every
  // firewall policy endpoint references a zone. Both are fetched whenever anything needs
  // to resolve a reference to a name.
  const needsNetworks = sections.length > 0;
  const needsZones = sections.includes("networks") || sections.includes("firewall");

  const networkRows = needsNetworks ? await listAll(client, consoleId, `${base}/networks`) : [];
  const zoneRows = needsZones ? await listAll(client, consoleId, `${base}/firewall/zones`) : [];

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

  if (sections.includes("networks")) {
    out.sections.networks = normaliseNetworks(networkRows, zonesById);
  }

  if (sections.includes("wifi")) {
    const rows = await listAll(client, consoleId, `${base}/wifi/broadcasts`);
    out.sections.wifi = normaliseWifi(rows, networksById);
  }

  if (sections.includes("firewall")) {
    const policies = await listAll(client, consoleId, `${base}/firewall/policies`);
    out.sections.firewall = normaliseFirewall(zoneRows, policies, networksById);
  }

  if (sections.includes("dns")) {
    const rows = await listAll(client, consoleId, `${base}/dns/policies`);
    out.sections.dns = normaliseDns(rows);
  }

  return out;
}
