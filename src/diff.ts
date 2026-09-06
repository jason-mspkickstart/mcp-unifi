import type { NormalisedConfig, SectionName } from "./normalise";

export interface Difference {
  /** Dotted path into the section, for example "networks.IoT.dhcp.dnsServers". */
  path: string;
  baseline: unknown;
  target: unknown;
  kind: "missing_on_target" | "extra_on_target" | "value_differs";
}

export interface ConsoleDiff {
  consoleId: string;
  section: SectionName;
  inSync: boolean;
  differences: Difference[];
  error?: string;
}

/** Arrays of scalars are compared as sets, since ordering is rarely meaningful in UniFi. */
function scalarSetEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

function compare(baseline: unknown, target: unknown, path: string, out: Difference[]): void {
  if (baseline === target) return;

  if (Array.isArray(baseline) && Array.isArray(target)) {
    const scalars = baseline.every((v) => typeof v !== "object") && target.every((v) => typeof v !== "object");
    if (scalars) {
      if (!scalarSetEqual(baseline, target)) {
        out.push({ path, baseline, target, kind: "value_differs" });
      }
      return;
    }
    // Object arrays are matched on name, which is the identity key everywhere in the
    // normalised model. Index matching would report every insertion as wholesale drift.
    const byName = (arr: unknown[]) =>
      new Map(arr.map((v) => [String((v as { name?: string }).name ?? ""), v]));
    const bm = byName(baseline);
    const tm = byName(target);
    for (const [name, bv] of bm) {
      if (!tm.has(name)) out.push({ path: `${path}.${name}`, baseline: bv, target: null, kind: "missing_on_target" });
      else compare(bv, tm.get(name), `${path}.${name}`, out);
    }
    for (const [name, tv] of tm) {
      if (!bm.has(name)) out.push({ path: `${path}.${name}`, baseline: null, target: tv, kind: "extra_on_target" });
    }
    return;
  }

  if (baseline && target && typeof baseline === "object" && typeof target === "object") {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(target)]);
    for (const k of keys) {
      compare((baseline as any)[k], (target as any)[k], `${path}.${k}`, out);
    }
    return;
  }

  out.push({ path, baseline, target, kind: "value_differs" });
}

export function diffSection(
  baseline: NormalisedConfig,
  target: NormalisedConfig,
  section: SectionName,
): ConsoleDiff {
  const differences: Difference[] = [];
  const b = (baseline.sections as Record<string, unknown>)[section];
  const t = (target.sections as Record<string, unknown>)[section];

  if (b === undefined || t === undefined) {
    return {
      consoleId: target.meta.consoleId,
      section,
      inSync: false,
      differences: [],
      error: `Section ${section} was not captured on ${b === undefined ? "the baseline" : "the target"}.`,
    };
  }

  compare(b, t, section, differences);
  return { consoleId: target.meta.consoleId, section, inSync: differences.length === 0, differences };
}
