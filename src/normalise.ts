/**
 * Turns per-console UniFi payloads into a model that can be compared across consoles.
 *
 * Source of truth is the official Network Integration API v10.4.57, reached through the
 * Site Manager Cloud Connector. Everything here maps that API's shapes, not the classic
 * controller API.
 *
 * The governing rule: identity is by name, never by id. Every id in this API is a UUID
 * minted by one console, so a baseline keyed on ids cannot be applied anywhere else.
 * References to networks, zones and traffic matching lists are therefore stored as the
 * referenced entity's name and resolved back to a local UUID at apply time.
 */

export type SectionName = "networks" | "wifi" | "firewall" | "dns";

/**
 * Only USER_DEFINED entities can be created, modified or deleted. Comparing the others
 * would report every stock policy as drift and then attempt a write the console will
 * reject, so they are dropped at capture time rather than filtered later.
 */
export type EntityOrigin = "USER_DEFINED" | "SYSTEM_DEFINED" | "DERIVED" | "ORCHESTRATED";

export function isUserDefined(entity: { metadata?: { origin?: string } }): boolean {
  return entity.metadata?.origin === "USER_DEFINED";
}

export interface ConfigMeta {
  consoleId: string;
  siteId: string;
  model: string;
  osVersion: string;
  networkApiVersion: string | null;
  capturedAt: string;
}

export interface DhcpConfig {
  mode: "SERVER" | "RELAY";
  rangeStart: string | null;
  rangeEnd: string | null;
  leaseTimeSeconds: number | null;
  dnsServers: string[];
  ntpServers: string[];
  domainName: string | null;
  relayServers: string[];
}

export interface NetworkSection {
  /** Identity key across consoles. */
  name: string;
  management: string;
  vlanId: number | null;
  enabled: boolean;
  isDefault: boolean;
  hostIpAddress: string | null;
  prefixLength: number | null;
  autoScaleEnabled: boolean | null;
  dhcp: DhcpConfig | null;
  internetAccessEnabled: boolean | null;
  isolationEnabled: boolean | null;
  mdnsForwardingEnabled: boolean | null;
  cellularBackupEnabled: boolean | null;
  /** Firewall zone name, resolved from zoneId at capture time. */
  zoneRef: string | null;
}

export interface WifiSection {
  name: string;
  enabled: boolean;
  hidden: boolean | null;
  bands: string[];
  /** Network name this SSID is bridged onto. */
  networkRef: string | null;
  securityType: string | null;
  guest: boolean | null;
}

export interface FirewallZone {
  name: string;
  /** Network names attached to this zone, not their UUIDs. */
  networkRefs: string[];
}

export interface TrafficFilter {
  type: string;
  matchOpposite: boolean | null;
  /** Entity names where the filter referenced networks, VPNs or matching lists. */
  refs: string[];
  /** Literal values where the filter referenced addresses, ports, domains or regions. */
  values: string[];
}

export interface FirewallEndpoint {
  /** Zone name, resolved from zoneId. */
  zoneRef: string | null;
  trafficFilter: TrafficFilter | null;
}

export interface FirewallPolicy {
  name: string;
  description: string | null;
  enabled: boolean;
  action: string;
  /**
   * Position among the managed policies only, renumbered from zero. The absolute index
   * from the console is meaningless across consoles with different stock policy counts,
   * and is deprecated on write anyway.
   */
  relativeIndex: number;
  ipVersion: string | null;
  protocol: string | null;
  connectionStates: string[];
  loggingEnabled: boolean;
  ipsecFilter: string | null;
  scheduleMode: string | null;
  source: FirewallEndpoint;
  destination: FirewallEndpoint;
}

export interface FirewallSection {
  zones: FirewallZone[];
  policies: FirewallPolicy[];
}

export interface DnsPolicy {
  type: string;
  domain: string | null;
  enabled: boolean;
  /** Record payload varies by type, so the discriminating value is kept flat. */
  value: string | null;
  ttlSeconds: number | null;
}

export interface NormalisedConfig {
  meta: ConfigMeta;
  sections: {
    networks?: NetworkSection[];
    wifi?: WifiSection[];
    firewall?: FirewallSection;
    dns?: DnsPolicy[];
  };
}

/** Resolves a list of UUIDs to names, dropping any that cannot be resolved. */
function refNames(ids: unknown, lookup: Map<string, string>): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => lookup.get(String(id))).filter((n): n is string => Boolean(n)).sort();
}

export function normaliseNetworks(rows: unknown[], zonesById: Map<string, string>): NetworkSection[] {
  return (rows as Record<string, any>[])
    .map((row) => {
      const v4 = row.ipv4Configuration ?? null;
      const d = v4?.dhcpConfiguration ?? null;

      return {
        name: String(row.name ?? "unnamed"),
        management: String(row.management ?? "UNKNOWN"),
        vlanId: row.vlanId === undefined || row.vlanId === null ? null : Number(row.vlanId),
        enabled: row.enabled !== false,
        isDefault: row.default === true,
        hostIpAddress: v4?.hostIpAddress ?? null,
        prefixLength: v4?.prefixLength ?? null,
        autoScaleEnabled: v4?.autoScaleEnabled ?? null,
        dhcp: d
          ? {
              mode: d.mode === "RELAY" ? "RELAY" : "SERVER",
              rangeStart: d.ipAddressRange?.start ?? null,
              rangeEnd: d.ipAddressRange?.stop ?? null,
              leaseTimeSeconds: d.leaseTimeSeconds ?? null,
              // Already an array in this API, unlike the classic dhcpd_dns_1..4 fields.
              dnsServers: Array.isArray(d.dnsServerIpAddressesOverride)
                ? [...d.dnsServerIpAddressesOverride].sort()
                : [],
              ntpServers: Array.isArray(d.ntpServerIpAddresses) ? [...d.ntpServerIpAddresses].sort() : [],
              domainName: d.domainName ?? null,
              relayServers: Array.isArray(d.dhcpServerIpAddresses) ? [...d.dhcpServerIpAddresses].sort() : [],
            }
          : null,
        internetAccessEnabled: row.internetAccessEnabled ?? null,
        isolationEnabled: row.isolationEnabled ?? null,
        mdnsForwardingEnabled: row.mdnsForwardingEnabled ?? null,
        cellularBackupEnabled: row.cellularBackupEnabled ?? null,
        zoneRef: row.zoneId ? zonesById.get(String(row.zoneId)) ?? null : null,
      };
    })
    // Sorted by identity key so two consoles compare cleanly regardless of return order.
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function normaliseWifi(rows: unknown[], networksById: Map<string, string>): WifiSection[] {
  return (rows as Record<string, any>[])
    .map((row) => ({
      name: String(row.name ?? "unnamed"),
      enabled: row.enabled !== false,
      hidden: row.hideSsid ?? row.hidden ?? null,
      bands: Array.isArray(row.bands) ? [...row.bands].map(String).sort() : [],
      networkRef: row.networkId ? networksById.get(String(row.networkId)) ?? null : null,
      securityType: row.security?.type ?? row.securityType ?? null,
      guest: row.guest ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Flattens a firewall traffic filter into refs plus literal values.
 *
 * The API models these as a discriminated union with a different payload key per type
 * (networkIds, ipAddresses, ports, domains, regions and so on). Rather than model every
 * variant, the discriminator is kept and the payload split into things that need
 * resolving on the target console and things that are portable as written.
 */
function normaliseTrafficFilter(
  filter: Record<string, any> | null | undefined,
  refs: Map<string, string>,
): TrafficFilter | null {
  if (!filter) return null;

  const idKeys = ["networkIds", "vpnServerIds", "trafficMatchingListId", "siteToSiteVpnTunnelId"];
  const valueKeys = ["ipAddresses", "ports", "domains", "regions", "macAddresses", "applicationIds", "applicationCategoryIds", "ipv6Iid"];

  const collectedRefs: string[] = [];
  for (const key of idKeys) {
    const v = filter[key];
    if (Array.isArray(v)) collectedRefs.push(...refNames(v, refs));
    else if (v) {
      const name = refs.get(String(v));
      if (name) collectedRefs.push(name);
    }
  }

  const collectedValues: string[] = [];
  for (const key of valueKeys) {
    const v = filter[key];
    if (Array.isArray(v)) collectedValues.push(...v.map(String));
    else if (v !== undefined && v !== null) collectedValues.push(String(v));
  }

  return {
    type: String(filter.type ?? "UNKNOWN"),
    matchOpposite: filter.matchOpposite ?? null,
    refs: collectedRefs.sort(),
    values: collectedValues.sort(),
  };
}

/** Protocol matching is a union too, so reduce it to one comparable string. */
function protocolLabel(scope: Record<string, any> | null | undefined): string | null {
  const p = scope?.protocol;
  if (!p) return null;
  if (p.type === "NAMED_PROTOCOL") return String(p.name ?? "named");
  if (p.type === "PRESET") return String(p.name ?? "preset");
  if (p.type === "PROTOCOL_NUMBER") return `proto-${p.protocolNumber}`;
  return String(p.type);
}

export function normaliseFirewall(
  zoneRows: unknown[],
  policyRows: unknown[],
  networksById: Map<string, string>,
): FirewallSection {
  const zonesById = new Map<string, string>();
  for (const z of zoneRows as Record<string, any>[]) {
    if (z.id && z.name) zonesById.set(String(z.id), String(z.name));
  }

  // Zones and networks share the reference namespace, because a traffic filter can point
  // at either and both are resolved by name on apply.
  const refs = new Map([...networksById, ...zonesById]);

  const zones: FirewallZone[] = (zoneRows as Record<string, any>[])
    // System-defined zones are kept, because networks legitimately attach to them and a
    // network's zoneRef would otherwise dangle. Their membership is still comparable.
    .map((z) => ({
      name: String(z.name ?? "unnamed"),
      networkRefs: refNames(z.networkIds, networksById),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const policies: FirewallPolicy[] = (policyRows as Record<string, any>[])
    // Stock and derived policies cannot be modified, so including them would produce
    // drift that is impossible to act on.
    .filter(isUserDefined)
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .map((row, i) => ({
      name: String(row.name ?? `policy-${i}`),
      description: row.description ?? null,
      enabled: row.enabled !== false,
      action: String(row.action?.type ?? "UNKNOWN"),
      relativeIndex: i,
      ipVersion: row.ipProtocolScope?.ipVersion ?? null,
      protocol: protocolLabel(row.ipProtocolScope),
      connectionStates: Array.isArray(row.connectionStateFilter)
        ? [...row.connectionStateFilter].map(String).sort()
        : [],
      loggingEnabled: row.loggingEnabled === true,
      ipsecFilter: row.ipsecFilter ?? null,
      scheduleMode: row.schedule?.mode ?? null,
      source: {
        zoneRef: row.source?.zoneId ? zonesById.get(String(row.source.zoneId)) ?? null : null,
        trafficFilter: normaliseTrafficFilter(row.source?.trafficFilter, refs),
      },
      destination: {
        zoneRef: row.destination?.zoneId ? zonesById.get(String(row.destination.zoneId)) ?? null : null,
        trafficFilter: normaliseTrafficFilter(row.destination?.trafficFilter, refs),
      },
    }));

  return { zones, policies };
}

export function normaliseDns(rows: unknown[]): DnsPolicy[] {
  return (rows as Record<string, any>[])
    .filter(isUserDefined)
    .map((row) => ({
      type: String(row.type ?? "UNKNOWN"),
      domain: row.domain ?? null,
      enabled: row.enabled !== false,
      // The record payload key varies by type, so take whichever is present.
      value:
        row.ipv4Address ??
        row.ipv6Address ??
        row.target ??
        row.text ??
        row.forwardServer ??
        null,
      ttlSeconds: row.ttlSeconds ?? null,
    }))
    .sort((a, b) => `${a.type}:${a.domain}`.localeCompare(`${b.type}:${b.domain}`));
}
