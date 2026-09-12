/**
 * `dxrouter cost` — what we currently believe about cache state, and how strongly (§13).
 *
 * This is the answer to the M2 question, rendered for a human: per route, which prefix
 * layers we believe are cached, how many tokens that covers, and on what evidence. It is
 * inspection only. There is no flag here that pins a route, changes a policy or claims a
 * saving, because M2 has no authority to do any of those and a CLI is the easiest place
 * for that authority to leak in unnoticed.
 *
 * Two rules the formatting enforces rather than documents:
 *
 *  - A provider with no verified cache model prints `-` for tokens, never `0`. Zero is a
 *    measurement; `-` is the absence of one (I4).
 *  - `assumed` and `confirmed` are never summed into one figure. They are separate
 *    columns all the way to the terminal, so a reader cannot accidentally add them (I3).
 *
 * `now` is injected; the same database renders the same text.
 */

import { describePricing } from "../cache/pricing/loader.js";
import { entryState } from "../cache/entry.js";
import { DEFAULT_CACHE_POLICY } from "../cache/policy.js";

const pad = (v, n) => String(v ?? "").padEnd(n);

/** `-` rather than `0` when the route can claim no economics at all. */
export function formatTokens(tokens, economics) {
  if (!economics) return "-";
  return String(Number(tokens) || 0);
}

export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export const ENTRY_COLUMNS = Object.freeze(["PROVIDER", "MODEL", "LAYER", "TOKENS", "PROV", "STORED", "EFFECTIVE", "EVIDENCE", "TTL LEFT"]);

/**
 * One line per persisted cache entry, with the effective confidence recomputed at `now`.
 * The stored value is shown next to it: an operator asking "why is this cold?" needs to
 * see both the recorded evidence and the half-life step that degraded it.
 */
export function renderEntries(entries, { now = 0, policy = DEFAULT_CACHE_POLICY, registry = null } = {}) {
  if (!entries?.length) return "no cache entries recorded";
  const head = [pad(ENTRY_COLUMNS[0], 12), pad(ENTRY_COLUMNS[1], 22), pad(ENTRY_COLUMNS[2], 9), pad(ENTRY_COLUMNS[3], 8), pad(ENTRY_COLUMNS[4], 10), pad(ENTRY_COLUMNS[5], 10), pad(ENTRY_COLUMNS[6], 10), pad(ENTRY_COLUMNS[7], 24), ENTRY_COLUMNS[8]].join(" ");
  const lines = entries.map((e) => {
    const state = entryState(e, now, policy);
    const economics = registry ? registry.hasEconomics(e.provider) : e.ttl_s > 0;
    return [
      pad(e.provider, 12),
      pad(e.model, 22),
      pad(e.layer, 9),
      pad(formatTokens(e.tokens, economics), 8),
      pad(e.tokens_provenance, 10),
      pad(state.stored_confidence, 10),
      pad(state.confidence, 10),
      pad(e.evidence, 24),
      formatRemaining(state.remaining_ms),
    ].join(" ").trimEnd();
  });
  return [head, ...lines].join("\n");
}

/** Persisted counts per provider and confidence. Columns, never a total. */
export function renderStats(stats) {
  if (!stats?.length) return "no cache entries recorded";
  const head = [pad("PROVIDER", 12), pad("CONFIDENCE", 12), pad("ENTRIES", 8), "TOKENS"].join(" ");
  const lines = stats.map((s) => [pad(s.provider, 12), pad(s.confidence, 12), pad(s.entries, 8), s.tokens].join(" "));
  return [head, ...lines].join("\n");
}

/** Provider cache reporting, straight from `turn_results`. The Q1 population. */
export function renderCoverage(rows) {
  if (!rows?.length) return "no provider results recorded";
  const head = [pad("PROVIDER", 12), pad("RESULTS", 8), pad("REPORTED", 9), pad("SILENT", 7), pad("CONFIRMED", 10), pad("ASSUMED", 8), pad("UNKNOWN", 8), "SILENT+ASSUMED"].join(" ");
  const lines = rows.map((r) =>
    [
      pad(r.provider, 12),
      pad(r.total, 8),
      pad(r.reported_read, 9),
      pad(r.silent, 7),
      pad(r.confirmed, 10),
      pad(r.assumed, 8),
      pad(r.unknown, 8),
      // The population where cache economics would rest on `assumed` alone (§19.4).
      r.silent_but_assumed,
    ].join(" "),
  );
  return [head, ...lines].join("\n");
}

/**
 * The whole view.
 *
 * @param {object} args
 * @param {object} args.store an open continuity store
 * @param {object} args.registry a pricing registry
 * @param {object} [args.clock] Clock port
 * @param {object} [args.options] `{pricing, json, provider, model, limit}`
 */
export function renderCostView({ store, registry, clock = null, options = {}, policy = DEFAULT_CACHE_POLICY } = {}) {
  const now = clock?.now ? clock.now() : 0;
  const { pricing = false, json = false, provider = null, model = null, since = 0 } = options;

  const entries =
    provider && model ? store.cache.listCacheEntriesForRoute(store.db, provider, model) : [];
  const stats = store.cache.cacheEntryStats(store.db);
  const coverage = store.turnResults.cacheReportingCoverage(store.db, { since, provider });

  if (json) {
    const payload = {
      now,
      pricing_version: registry.version,
      pricing: registry.rows,
      diagnostics: registry.diagnostics,
      entries: entries.map((e) => ({ ...e, state: entryState(e, now, policy) })),
      stats,
      coverage,
    };
    return { text: JSON.stringify(payload, null, 2), count: stats.length };
  }

  const sections = [];
  if (pricing) {
    sections.push("## cache pricing", "", describePricing(registry), "");
    if (registry.diagnostics.length) {
      sections.push("### pricing diagnostics", "");
      for (const d of registry.diagnostics) sections.push(`- [${d.level}] ${d.provider}: ${d.message}`);
      sections.push("");
    }
    sections.push(`pricing version: ${registry.version}`);
    return { text: sections.join("\n"), count: registry.rows.length };
  }

  sections.push("## cache belief", "");
  sections.push(provider && model ? renderEntries(entries, { now, policy, registry }) : renderStats(stats));
  sections.push("", "## provider cache reporting", "", renderCoverage(coverage), "");
  sections.push(`pricing version: ${registry.version} (${registry.counts.ok} ok, ${registry.counts.stale} stale, ${registry.counts.disabled} disabled)`);
  // Said once, in the place an operator will read a number and want to act on it.
  sections.push("assumed and confirmed are reported separately on purpose; they are not addable (I3).");
  return { text: sections.join("\n"), count: entries.length || stats.length };
}

export default renderCostView;
