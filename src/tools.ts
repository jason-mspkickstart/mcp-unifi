import { allowedConsoles, maxBatch, writesEnabled, type Env } from "./env";
import { UnifiClient, UnifiError, MIN_CONNECTOR_FIRMWARE, type ConsoleSummary } from "./unifi";
import { captureConfig, SECTIONS } from "./capture";
import { diffSection, type ConsoleDiff } from "./diff";
import { cachedJson } from "./cache";
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
 * Runs a per-console job across a capped batch and returns the leftovers rather than
 * carrying on. Workers limits subrequests per request, and each console costs several,
 * so an uncapped fan-out over a real fleet would hit that ceiling partway through and
 * fail the whole call.
 */
async function batched<T>(
  ctx: Ctx,
  consoleIds: string[],
  job: (id: string) => Promise<T>,
): Promise<{ results: T[]; failures: { consoleId: string; error: string }[]; remaining: string[] }> {
  const limit = maxBatch(ctx.env);
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

      const { results, failures, remaining } = await batched<ConsoleDiff>(ctx, targets, async (id) => {
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

      const { results, failures, remaining } = await batched(ctx, targets, async (id) => {
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
