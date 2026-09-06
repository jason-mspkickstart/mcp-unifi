import { allowedConsoles, maxBatch, writesEnabled, type Env } from "./env";
import { UnifiClient, UnifiError, MIN_CONNECTOR_FIRMWARE, type ConsoleSummary } from "./unifi";
import { captureConfig, SECTIONS } from "./capture";
import { diffSection, type ConsoleDiff } from "./diff";
import { cachedJson } from "./cache";
import { captureClients, captureDevices, captureHealth, type ClientState, type DeviceState, type HealthState } from "./state";
import type { NormalisedConfig, SectionName } from "./normalise";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>, ctx: Ctx) => Promise<unknown>;
}

export interface Ctx {
  client: UnifiClient;
  env: Env;
  apiKey: string;
}

const SECTION_ENUM = { type: "string", enum: SECTIONS };

/** Applies the allowlist and turns a rejected id into a message that says why. */
function assertAllowed(env: Env, ids: string[]): void {
  const allow = allowedConsoles(env);
  if (!allow) return;
  const blocked = ids.filter((id) => !allow.has(id));
  if (blocked.length) {
    throw new UnifiError(
      `Not in this deployment's allowlist: ${blocked.join(", ")}. Call list_consoles to see what is available.`,
      403,
    );
  }
}

async function consoleIndex(ctx: Ctx): Promise<Map<string, ConsoleSummary>> {
  const consoles = await cachedJson(ctx.apiKey, ["hosts"], 60, () => ctx.client.listConsoles());
  return new Map(consoles.map((c) => [c.consoleId, c]));
}

async function captureFor(ctx: Ctx, consoleId: string, sections: SectionName[]): Promise<NormalisedConfig> {
  const index = await consoleIndex(ctx);
  const summary = index.get(consoleId);
  if (!summary) {
    throw new UnifiError(`Console ${consoleId} is not visible to this API key.`, 404, consoleId);
  }
  // Checked before spending any subrequests, because the proxy failure for old firmware
  // looks like an ordinary 404 and wastes a round trip to discover.
  if (!summary.connectorCapable) {
    throw new UnifiError(
      `Console ${consoleId} runs ${summary.osVersion}, below the ${MIN_CONNECTOR_FIRMWARE} needed for the Cloud Connector proxy. It cannot be managed remotely until it is upgraded.`,
      412,
      consoleId,
    );
  }
  return cachedJson(ctx.apiKey, ["config", consoleId, sections.join(",")], 30, () =>
    captureConfig(ctx.client, consoleId, sections, { model: summary.model, osVersion: summary.osVersion }),
  );
}

/**
 * Rough subrequest cost per console, per section.
 *
 * Workers caps subrequests per request (50 on the free plan) and diff_config fans out
 * across consoles inside a single request, so the batch size has to account for what each
 * console actually costs. Networks is by far the most expensive because every network is
 * fetched individually for its subnet and DHCP detail.
 *
 * Fixed overhead per console is roughly: site lookup, info, the section's list call.
 */
const SECTION_COST: Record<SectionName, number> = {
  networks: 12, // site + info + list + zones + up to ~8 network detail calls
  wifi: 4,
  firewall: 5,
  dns: 4,
};

/** State calls are cheap: a site lookup plus one endpoint. */
const STATE_COST = 3;

/** Leaves headroom below the free plan's 50, since the count is an estimate. */
const SUBREQUEST_BUDGET = 40;

/**
 * The configured MAX_BATCH is an upper bound, not a target. A networks diff across six
 * consoles would blow the subrequest cap partway through and fail the whole call, which
 * loses the answer for the consoles that had already succeeded.
 */
function effectiveBatch(env: Env, section: SectionName): number {
  const configured = maxBatch(env);
  const affordable = Math.max(1, Math.floor(SUBREQUEST_BUDGET / SECTION_COST[section]));
  return Math.min(configured, affordable);
}

/**
 * Runs a per-console job across a capped batch and returns the leftovers rather than
 * carrying on. Workers limits subrequests per request, and each console costs several,
 * so an uncapped fan-out over a real fleet would hit that ceiling partway through and
 * fail the whole call.
 */
async function batched<T>(
  ctx: Ctx,
  consoleIds: string[],
  section: SectionName,
  job: (id: string) => Promise<T>,
): Promise<{ results: T[]; failures: { consoleId: string; error: string }[]; remaining: string[] }> {
  const limit = effectiveBatch(ctx.env, section);
  const batch = consoleIds.slice(0, limit);
  const remaining = consoleIds.slice(limit);

  const settled = await Promise.allSettled(batch.map((id) => job(id)));
  const results: T[] = [];
  const failures: { consoleId: string; error: string }[] = [];

  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    // One unreachable console should not lose the answer for the other five.
    else failures.push({ consoleId: batch[i], error: String(outcome.reason?.message ?? outcome.reason) });
  });

  return { results, failures, remaining };
}

/**
 * Fans a per-console job across the fleet with a cost-aware cap. Shares the failure
 * handling of the config batcher: one unreachable console must not lose the answer for
 * the rest, which matters more here because state is what you check during an incident.
 */
async function fanOut<T>(
  ctx: Ctx,
  consoleIds: string[],
  costPerConsole: number,
  job: (id: string, summary: ConsoleSummary) => Promise<T>,
): Promise<{
  results: T[];
  offline: { consoleId: string; name: string; since: string | null }[];
  failures: { consoleId: string; error: string }[];
  remaining: string[];
}> {
  const index = await consoleIndex(ctx);
  const affordable = Math.max(1, Math.floor(SUBREQUEST_BUDGET / costPerConsole));
  const limit = Math.min(maxBatch(ctx.env) * 2, affordable);

  const batch = consoleIds.slice(0, limit);
  const remaining = consoleIds.slice(limit);

  /**
   * A console the cloud already reports as disconnected is separated out before any
   * request is attempted. It is not a failure, it is a fact worth reporting, and the
   * proxy would otherwise spend a subrequest to return a 404 that reads like a bug.
   */
  const offline: { consoleId: string; name: string; since: string | null }[] = [];
  const reachable: string[] = [];
  for (const id of batch) {
    const summary = index.get(id);
    if (summary && !summary.online) {
      offline.push({ consoleId: id, name: summary.name, since: summary.lastStateChange });
    } else {
      reachable.push(id);
    }
  }

  const settled = await Promise.allSettled(
    reachable.map(async (id) => {
      const summary = index.get(id);
      if (!summary) throw new UnifiError(`Console ${id} is not visible to this API key.`, 404, id);
      if (!summary.connectorCapable) {
        throw new UnifiError(
          `Console ${id} runs ${summary.osVersion}, below the ${MIN_CONNECTOR_FIRMWARE} needed for the Cloud Connector proxy.`,
          412,
          id,
        );
      }
      return job(id, summary);
    }),
  );

  const results: T[] = [];
  const failures: { consoleId: string; error: string }[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else failures.push({ consoleId: reachable[i], error: String(outcome.reason?.message ?? outcome.reason) });
  });

  return { results, offline, failures, remaining };
}

const readTools: ToolDef[] = [
  {
    name: "list_consoles",
    description:
      "List the UniFi consoles this API key can reach, with model, firmware and whether the Cloud Connector proxy is available on each. Start here to get console IDs for the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        onlyManageable: {
          type: "boolean",
          description: "Return only consoles whose firmware supports the Cloud Connector proxy.",
        },
      },
    },
    handler: async (args, ctx) => {
      const all = await cachedJson(ctx.apiKey, ["hosts"], 60, () => ctx.client.listConsoles());
      const allow = allowedConsoles(ctx.env);
      let list = allow ? all.filter((c) => allow.has(c.consoleId)) : all;
      if (args.onlyManageable) list = list.filter((c) => c.connectorCapable);
      return { count: list.length, consoles: list };
    },
  },
  {
    name: "verify_console",
    description:
      "Check whether a console is actually reachable through the Cloud Connector proxy, and report its firmware, sites and which config sections can be read. Use this before trusting a diff or an apply against an unfamiliar console.",
    inputSchema: {
      type: "object",
      properties: { consoleId: { type: "string" } },
      required: ["consoleId"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const index = await consoleIndex(ctx);
      const summary = index.get(args.consoleId);
      if (!summary) return { reachable: false, reason: "Not visible to this API key." };
      if (!summary.connectorCapable) {
        return {
          reachable: false,
          firmware: summary.osVersion,
          reason: `Firmware is below ${MIN_CONNECTOR_FIRMWARE}, so there is no Cloud Connector proxy on this console.`,
        };
      }
      const checks: Record<string, string> = {};
      for (const section of SECTIONS) {
        try {
          await captureFor(ctx, args.consoleId, [section]);
          checks[section] = "ok";
        } catch (err) {
          checks[section] = err instanceof Error ? err.message : String(err);
        }
      }
      return { reachable: true, console: summary, sections: checks };
    },
  },
  {
    name: "get_config",
    description:
      "Read one or more configuration sections from a single console, normalised so it can be compared with other consoles. References to networks and firewall groups are resolved to names rather than console-specific IDs.",
    inputSchema: {
      type: "object",
      properties: {
        consoleId: { type: "string" },
        sections: { type: "array", items: SECTION_ENUM, description: "Defaults to networks." },
      },
      required: ["consoleId"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const sections: SectionName[] = args.sections?.length ? args.sections : ["networks"];
      return captureFor(ctx, args.consoleId, sections);
    },
  },
  {
    name: "diff_config",
    description:
      "Compare one section across a batch of consoles against a baseline console, and report exactly where they disagree. Consoles are processed in a capped batch; any leftovers come back in 'remaining' to feed into the next call.",
    inputSchema: {
      type: "object",
      properties: {
        baselineConsoleId: {
          type: "string",
          description: "The console whose configuration is treated as correct.",
        },
        consoleIds: { type: "array", items: { type: "string" } },
        section: SECTION_ENUM,
      },
      required: ["baselineConsoleId", "consoleIds", "section"],
    },
    handler: async (args, ctx) => {
      const section = args.section as SectionName;
      assertAllowed(ctx.env, [args.baselineConsoleId, ...args.consoleIds]);

      const baseline = await captureFor(ctx, args.baselineConsoleId, [section]);
      const targets = (args.consoleIds as string[]).filter((id) => id !== args.baselineConsoleId);

      const { results, failures, remaining } = await batched<ConsoleDiff>(ctx, targets, section, async (id) => {
        const target = await captureFor(ctx, id, [section]);
        return diffSection(baseline, target, section);
      });

      return {
        section,
        baselineConsoleId: args.baselineConsoleId,
        inSync: results.filter((r) => r.inSync).map((r) => r.consoleId),
        drift: results.filter((r) => !r.inSync),
        failures,
        remaining,
        note: remaining.length
          ? `${remaining.length} console(s) not yet checked. Call diff_config again with consoleIds set to 'remaining'.`
          : undefined,
      };
    },
  },
  {
    name: "get_health",
    description:
      "Current operational health for one console: WAN availability and latency, ISP, client counts, device counts, and gateway CPU and memory. This is live state, not configuration. Use it to answer whether a site is healthy right now.",
    inputSchema: {
      type: "object",
      properties: { consoleId: { type: "string" } },
      required: ["consoleId"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const index = await consoleIndex(ctx);
      const summary = index.get(args.consoleId);
      if (!summary) throw new UnifiError(`Console ${args.consoleId} is not visible to this API key.`, 404, args.consoleId);
      // Short TTL: this is live state, and a stale answer during an incident is worse
      // than a slow one.
      return cachedJson(ctx.apiKey, ["health", args.consoleId], 15, () =>
        captureHealth(ctx.client, args.consoleId, summary.name),
      );
    },
  },
  {
    name: "fleet_health",
    description:
      "Health across every reachable console at once, reduced to one comparable row per site. This is the fastest way to answer 'is anything wrong across my sites', which the UniFi interface cannot show in a single view. Consoles that cannot be reached are listed separately rather than failing the call.",
    inputSchema: {
      type: "object",
      properties: {
        consoleIds: {
          type: "array",
          items: { type: "string" },
          description: "Defaults to every console this key can reach.",
        },
      },
    },
    handler: async (args, ctx) => {
      const index = await consoleIndex(ctx);
      const allow = allowedConsoles(ctx.env);
      const ids: string[] = args.consoleIds?.length
        ? args.consoleIds
        : [...index.keys()].filter((id) => !allow || allow.has(id));
      assertAllowed(ctx.env, ids);

      const { results, offline, failures, remaining } = await fanOut<HealthState>(
        ctx,
        ids,
        STATE_COST,
        (id, summary) =>
          cachedJson(ctx.apiKey, ["health", id], 15, () => captureHealth(ctx.client, id, summary.name)),
      );

      // Surfaced explicitly so the interesting sites do not have to be spotted by eye.
      const attention = results
        .filter(
          (h) =>
            h.status !== "ok" ||
            h.devices.disconnected > 0 ||
            h.devices.pending > 0 ||
            (h.wans[0]?.availabilityPercent ?? 100) < 100,
        )
        .map((h) => h.consoleName);

      return {
        checked: results.length,
        needsAttention: [...attention, ...offline.map((o) => `${o.name} (offline)`)],
        offline,
        sites: results,
        failures,
        remaining,
        note: remaining.length
          ? `${remaining.length} console(s) not checked in this call. Pass them as consoleIds to continue.`
          : undefined,
      };
    },
  },
  {
    name: "list_devices",
    description:
      "Devices on one console with their model, firmware, connection state, client count and UniFi experience score. Reduced to the fields that matter for support, because the raw payload includes port and radio tables large enough to be unusable.",
    inputSchema: {
      type: "object",
      properties: {
        consoleId: { type: "string" },
        onlyProblems: {
          type: "boolean",
          description: "Return only devices that are disconnected, unadopted, upgradable, or scoring below 80.",
        },
      },
      required: ["consoleId"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const devices = await cachedJson(ctx.apiKey, ["devices", args.consoleId], 30, () =>
        captureDevices(ctx.client, args.consoleId),
      );
      const list = args.onlyProblems
        ? devices.filter(
            (d) => !d.connected || !d.adopted || d.upgradable || (d.satisfaction !== null && d.satisfaction < 80),
          )
        : devices;
      return { count: list.length, totalOnSite: devices.length, devices: list };
    },
  },
  {
    name: "firmware_report",
    description:
      "Firmware across the fleet, showing which devices have updates pending and where versions differ between sites. Answers the patch compliance question in one call rather than one console at a time.",
    inputSchema: {
      type: "object",
      properties: {
        consoleIds: { type: "array", items: { type: "string" }, description: "Defaults to all." },
      },
    },
    handler: async (args, ctx) => {
      const index = await consoleIndex(ctx);
      const allow = allowedConsoles(ctx.env);
      const ids: string[] = args.consoleIds?.length
        ? args.consoleIds
        : [...index.keys()].filter((id) => !allow || allow.has(id));
      assertAllowed(ctx.env, ids);

      const { results, offline, failures, remaining } = await fanOut(ctx, ids, STATE_COST, async (id, summary) => {
        const devices = await cachedJson(ctx.apiKey, ["devices", id], 30, () =>
          captureDevices(ctx.client, id),
        );
        return { consoleId: id, consoleName: summary.name, devices };
      });

      // Grouped by model so "every UAP6MP is on a different version" is visible at a
      // glance, which is the actual question behind a firmware audit.
      const byModel = new Map<string, Set<string>>();
      const pending: { site: string; device: string; model: string | null; version: string | null }[] = [];

      for (const site of results) {
        for (const d of (site.devices as DeviceState[])) {
          if (d.model && d.version) {
            const set = byModel.get(d.model) ?? new Set<string>();
            set.add(d.version);
            byModel.set(d.model, set);
          }
          if (d.upgradable) {
            pending.push({ site: site.consoleName, device: d.name, model: d.model, version: d.version });
          }
        }
      }

      const versionSpread = [...byModel.entries()]
        .map(([model, versions]) => ({ model, versions: [...versions].sort() }))
        .filter((entry) => entry.versions.length > 1);

      return {
        sitesChecked: results.length,
        updatesPending: pending,
        modelsWithMixedVersions: versionSpread,
        offline,
        failures,
        remaining,
        note: pending.length
          ? undefined
          : "No devices report a pending update across the consoles checked.",
      };
    },
  },
  {
    name: "list_clients",
    description:
      "Clients connected to one console, with their network, SSID, signal strength, WiFi retry rate and experience score. Reduced from a payload that carries around fifty fields per client. Use onlyProblems to surface the clients actually having a bad time rather than reading the whole list.",
    inputSchema: {
      type: "object",
      properties: {
        consoleId: { type: "string" },
        onlyProblems: {
          type: "boolean",
          description:
            "Return only clients with an experience score below 70, a signal weaker than -70dBm, or a WiFi retry rate above 20 percent.",
        },
        wirelessOnly: { type: "boolean", description: "Exclude wired clients." },
      },
      required: ["consoleId"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const clients = await cachedJson(ctx.apiKey, ["clients", args.consoleId], 30, () =>
        captureClients(ctx.client, args.consoleId),
      );

      let list: ClientState[] = clients;
      if (args.wirelessOnly) list = list.filter((c) => !c.wired);
      if (args.onlyProblems) {
        list = list.filter(
          (c) =>
            (c.satisfaction !== null && c.satisfaction < 70) ||
            (c.signalDbm !== null && c.signalDbm < -70) ||
            (c.txRetryPercent !== null && c.txRetryPercent > 20),
        );
      }

      return {
        count: list.length,
        totalOnSite: clients.length,
        wired: clients.filter((c) => c.wired).length,
        wireless: clients.filter((c) => !c.wired).length,
        guests: clients.filter((c) => c.guest).length,
        clients: list,
      };
    },
  },
  {
    name: "fleet_inventory",
    description:
      "Every device across every console in one call, as an asset register: site, name, model, firmware, adoption state and experience score. Use this for hardware audits, insurance schedules, or working out what is deployed where without opening each site.",
    inputSchema: {
      type: "object",
      properties: {
        consoleIds: { type: "array", items: { type: "string" }, description: "Defaults to all." },
      },
    },
    handler: async (args, ctx) => {
      const index = await consoleIndex(ctx);
      const allow = allowedConsoles(ctx.env);
      const ids: string[] = args.consoleIds?.length
        ? args.consoleIds
        : [...index.keys()].filter((id) => !allow || allow.has(id));
      assertAllowed(ctx.env, ids);

      const { results, offline, failures, remaining } = await fanOut(ctx, ids, STATE_COST, async (id, summary) => {
        const devices = await cachedJson(ctx.apiKey, ["devices", id], 30, () =>
          captureDevices(ctx.client, id),
        );
        return { consoleName: summary.name, consoleModel: summary.model, devices };
      });

      const rows: Record<string, unknown>[] = [];
      const modelCounts = new Map<string, number>();

      for (const site of results) {
        for (const d of site.devices as DeviceState[]) {
          rows.push({
            site: site.consoleName,
            name: d.name,
            model: d.model,
            version: d.version,
            mac: d.mac,
            ipAddress: d.ipAddress,
            adopted: d.adopted,
            connected: d.connected,
            satisfaction: d.satisfaction,
          });
          if (d.model) modelCounts.set(d.model, (modelCounts.get(d.model) ?? 0) + 1);
        }
      }

      return {
        totalDevices: rows.length,
        sitesChecked: results.length,
        byModel: Object.fromEntries([...modelCounts.entries()].sort((a, b) => b[1] - a[1])),
        devices: rows,
        offline,
        failures,
        remaining,
      };
    },
  },
  {
    name: "raw_request",
    description:
      "Escape hatch. Send an arbitrary request to a console through the Cloud Connector proxy, for anything the curated tools do not cover. The path is relative to the console's /proxy prefix, for example /network/api/s/default/rest/firewallrule.",
    inputSchema: {
      type: "object",
      properties: {
        consoleId: { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
        path: { type: "string" },
        body: { type: "object" },
      },
      required: ["consoleId", "method", "path"],
    },
    handler: async (args, ctx) => {
      assertAllowed(ctx.env, [args.consoleId]);
      const method = String(args.method).toUpperCase();
      if (method !== "GET" && !writesEnabled(ctx.env)) {
        throw new UnifiError(
          `raw_request is read only on this deployment. Set ENABLE_WRITES to true to allow ${method}.`,
          403,
        );
      }
      return ctx.client.proxy(args.consoleId, method, args.path, args.body);
    },
  },
];

const writeTools: ToolDef[] = [
  {
    name: "apply_config",
    description:
      "Bring a batch of consoles into line with a baseline console for one section. Without confirm set to true this returns the plan only and changes nothing, which is how you should always call it first.",
    inputSchema: {
      type: "object",
      properties: {
        baselineConsoleId: { type: "string" },
        consoleIds: { type: "array", items: { type: "string" } },
        section: SECTION_ENUM,
        confirm: {
          type: "boolean",
          description: "Must be true to actually write. Omit to get the plan.",
        },
      },
      required: ["baselineConsoleId", "consoleIds", "section"],
    },
    handler: async (args, ctx) => {
      const section = args.section as SectionName;
      assertAllowed(ctx.env, [args.baselineConsoleId, ...args.consoleIds]);

      const baseline = await captureFor(ctx, args.baselineConsoleId, [section]);
      const targets = (args.consoleIds as string[]).filter((id) => id !== args.baselineConsoleId);

      const { results, failures, remaining } = await batched(ctx, targets, section, async (id) => {
        const target = await captureFor(ctx, id, [section]);
        const d = diffSection(baseline, target, section);
        return { consoleId: id, changes: d.differences, inSync: d.inSync };
      });

      if (!args.confirm) {
        return {
          dryRun: true,
          section,
          plan: results,
          failures,
          remaining,
          note: "Nothing was changed. Review the plan, then call again with confirm set to true.",
        };
      }

      // Deliberately not implemented yet. Returning a clear refusal is far better than a
      // half-written implementation that leaves a fleet in a partial state. Firewall
      // apply in particular is two phases, because policy ordering is a separate endpoint
      // and the index field is deprecated on write.
      throw new UnifiError(
        "Writing is not implemented yet. The name-to-UUID reference resolver, the ordering pass for firewall policies, and a per-console rollback path all have to land before this can safely touch a client network. Use the dry run to see the plan.",
        501,
      );
    },
  },
];

export function toolsFor(env: Env): ToolDef[] {
  // Write tools are not registered at all when writes are off, so they never show up in
  // tools/list. A tool the model cannot see is a tool it cannot try to talk you into.
  return writesEnabled(env) ? [...readTools, ...writeTools] : readTools;
}
