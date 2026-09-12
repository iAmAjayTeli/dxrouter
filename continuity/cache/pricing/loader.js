/**
 * The pricing loader — §9.3, one table row at a time.
 *
 * | outcome                              | economics | provenance  | label                    |
 * |--------------------------------------|-----------|-------------|--------------------------|
 * | valid, verified, fresh               | used      | per §4      | none                     |
 * | valid, verified, stale               | used      | estimated   | cache-model-stale        |
 * | missing verified_at / verified_by    | disabled  | unavailable | cache-model-unavailable  |
 * | malformed YAML or failed schema      | disabled  | unavailable | cache-model-unavailable  |
 * | no file at all                       | none      | unavailable | cache-model-unavailable  |
 *
 * Four properties this module is responsible for, all of which are ways of not lying:
 *
 *  1. **Quarantine is per provider.** One bad file degrades one provider. There is no
 *     global fail-fast, because a pricing data asset must not be able to cause an
 *     outage.
 *  2. **Disabled is a record, not an absence.** A disabled provider gets a real
 *     `mechanism: none` record, so every reader takes the same branch it takes for a
 *     provider that genuinely has no cache — zero claimed economics (I4), still fully
 *     routable. It is never given another provider's ratios, a "reasonable default", or
 *     a guessed TTL.
 *  3. **Nothing is silent.** Every provider appears in `rows` with `ok` / `stale` /
 *     `disabled:<cause>`, and every degradation appears in `diagnostics` at the level
 *     §9.3 asks for. The host prints them; the engine does not own a console.
 *  4. **A broken `default` is the one hard failure — and it still is not fatal.** The
 *     loader synthesizes `default` in memory and records an error.
 *
 * Pure apart from the injected source: no clock (`now` is a parameter), no logging, no
 * process. `loadCacheModels` returns a frozen registry that can be built in a test in
 * one call.
 */

import { sha256Hex } from "../../canonical/serialize.js";
import { DEFAULT_CACHE_POLICY, maxAgeMs } from "../policy.js";
import { shippedSource } from "./source.js";
import { parseFlatYaml, YamlError } from "./yaml.js";
import {
  DISABLED_CAUSE,
  PRICING_LABELS,
  PRICING_STATUS,
  disabledCacheModel,
  validateCacheModel,
} from "./schema.js";

/** §9.2: the ten required before M3, plus the invariant entry. */
export const REQUIRED_PROVIDERS = Object.freeze([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "xai",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
]);

export const DEFAULT_PROVIDER_KEY = "default";

/** The record used when `default.yaml` itself cannot be loaded. */
const SYNTHETIC_DEFAULT = Object.freeze({
  ...disabledCacheModel(DEFAULT_PROVIDER_KEY, DISABLED_CAUSE.MALFORMED, "synthesized in memory"),
  version: "synthetic-1",
});

const DAY_MS = 86_400_000;

/** Content hash of the resolved set, for `decisions.cache_model_version`. */
export function cacheModelVersion(rows) {
  const canonical = rows
    .map((r) => [r.provider, r.status, r.cause ?? "", r.version, r.mechanism, r.verified_at ?? ""].join(""))
    .sort()
    .join("\n");
  return `cm1:${rows.length}:${sha256Hex(canonical).slice(0, 16)}`;
}

/** Load and classify one provider. Never throws. */
function loadOne(source, key, { now, policy }) {
  const text = source.read(key);
  if (typeof text !== "string") {
    return {
      model: disabledCacheModel(key, DISABLED_CAUSE.MISSING, "no pricing file"),
      status: PRICING_STATUS.DISABLED,
      cause: DISABLED_CAUSE.MISSING,
      detail: "no pricing file",
      level: "info",
      message: `no cache pricing record for ${key}; cache economics unavailable`,
    };
  }

  let parsed;
  try {
    parsed = parseFlatYaml(text);
  } catch (err) {
    const detail = err instanceof YamlError ? err.message : String(err?.message || err);
    return {
      model: disabledCacheModel(key, DISABLED_CAUSE.MALFORMED, detail),
      status: PRICING_STATUS.DISABLED,
      cause: DISABLED_CAUSE.MALFORMED,
      detail,
      level: "error",
      message: `cache pricing for ${key} is malformed: ${detail}; provider disabled (zero cache economics)`,
    };
  }

  const result = validateCacheModel(parsed, { provider: key });
  if (!result.ok) {
    return {
      model: disabledCacheModel(key, result.cause, result.detail),
      status: PRICING_STATUS.DISABLED,
      cause: result.cause,
      detail: result.detail,
      level: "error",
      message: `cache pricing for ${key} ${result.cause}: ${result.detail}; provider disabled (zero cache economics)`,
    };
  }

  const model = result.model;
  // A `mechanism: none` record is neither fresh nor stale: it claims nothing, so there
  // is nothing for age to erode. Calling it `ok` keeps the summary readable — the
  // mechanism column already says it contributes zero.
  if (model.mechanism === "none") {
    return {
      model,
      status: PRICING_STATUS.OK,
      cause: null,
      detail: "no cache economics claimed",
      level: null,
      message: null,
    };
  }

  const age_ms = model.verified_at === null ? null : now - model.verified_at;
  if (age_ms !== null && age_ms > maxAgeMs(policy)) {
    const days = Math.floor(age_ms / DAY_MS);
    return {
      model,
      status: PRICING_STATUS.STALE,
      cause: null,
      detail: `verified ${days}d ago (max ${policy.maxAgeDays}d)`,
      level: "warn",
      message: `cache pricing for ${key} was verified ${days}d ago (max ${policy.maxAgeDays}d); terms downgraded to estimated`,
    };
  }

  return { model, status: PRICING_STATUS.OK, cause: null, detail: null, level: null, message: null };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.source] a pricing source (`keys`/`read`); defaults to the shipped records
 * @param {number} [opts.now] epoch ms, from the Clock port on the host side
 * @param {object} [opts.policy] cache policy (`maxAgeDays`, `strictProviders`)
 * @param {string[]} [opts.keys] extra provider keys to resolve beyond the required ten
 */
export function loadCacheModels({ source = shippedSource(), now = 0, policy = DEFAULT_CACHE_POLICY, keys = [] } = {}) {
  const wanted = [...new Set([DEFAULT_PROVIDER_KEY, ...REQUIRED_PROVIDERS, ...source.keys(), ...keys])].sort();

  const models = new Map();
  const states = new Map();
  const diagnostics = [];
  const rows = [];

  for (const key of wanted) {
    const loaded = loadOne(source, key, { now, policy });
    let { model, status, cause, detail, level, message } = loaded;

    if (key === DEFAULT_PROVIDER_KEY && status === PRICING_STATUS.DISABLED) {
      // §9.3: the one hard failure, handled by synthesis rather than by exiting. The
      // original cause is kept in the message so the operator can fix the file.
      diagnostics.push({
        level: "error",
        provider: key,
        message: `the default cache pricing entry failed to load (${cause}: ${detail}); synthesized in memory`,
      });
      model = SYNTHETIC_DEFAULT;
      status = PRICING_STATUS.OK;
      cause = null;
      detail = "synthesized in memory";
      level = null;
      message = null;
    }

    models.set(key, model);
    states.set(key, { status, cause, detail });
    if (level && message) diagnostics.push({ level, provider: key, message });

    rows.push(
      Object.freeze({
        provider: key,
        status,
        cause,
        detail,
        mechanism: model.mechanism,
        version: model.version,
        verification_method: model.verification_method,
        verified_at: model.verified_at,
        verified_by: model.verified_by,
        source: model.source,
        age_days: model.verified_at === null ? null : Math.floor((now - model.verified_at) / DAY_MS),
        origin: typeof source.originOf === "function" ? source.originOf(key) : source.name ?? null,
        required: REQUIRED_PROVIDERS.includes(key),
      })
    );
  }

  const counts = rows.reduce(
    (acc, r) => {
      if (r.status === PRICING_STATUS.DISABLED) acc.disabled += 1;
      else if (r.status === PRICING_STATUS.STALE) acc.stale += 1;
      else acc.ok += 1;
      return acc;
    },
    { ok: 0, stale: 0, disabled: 0, total: rows.length }
  );

  // Opt-in strictness (§9.3): named providers whose disabled load the *host* turns into
  // a startup failure. The engine reports it; refusing to boot is a host decision.
  const strictFailures = policy.strictProviders.filter((p) => states.get(p)?.status === PRICING_STATUS.DISABLED);

  const registry = {
    version: cacheModelVersion(rows),
    keys: Object.freeze(wanted),
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
    diagnostics: Object.freeze(diagnostics),
    strictFailures: Object.freeze(strictFailures),

    /**
     * Never null. An unknown provider gets the `default` record, which is
     * `mechanism: none` — the §9.3 "no file at all" row, not a neighbour's ratios.
     */
    get(provider) {
      const key = String(provider ?? "").toLowerCase();
      return models.get(key) ?? models.get(DEFAULT_PROVIDER_KEY) ?? SYNTHETIC_DEFAULT;
    },

    /** `{status, cause, detail}` for a provider; `missing` for one never loaded. */
    statusOf(provider) {
      const key = String(provider ?? "").toLowerCase();
      return (
        states.get(key) ?? {
          status: PRICING_STATUS.DISABLED,
          cause: DISABLED_CAUSE.MISSING,
          detail: "provider not resolved",
        }
      );
    },

    /**
     * The decision labels this provider's pricing state forces. Returned as data so a
     * later milestone attaches them to a Decision instead of re-deriving the rule.
     */
    labelsFor(provider) {
      const { status } = registry.statusOf(provider);
      const model = registry.get(provider);
      if (status === PRICING_STATUS.STALE) return [PRICING_LABELS.STALE];
      if (status === PRICING_STATUS.DISABLED || model.mechanism === "none") return [PRICING_LABELS.UNAVAILABLE];
      return [];
    },

    /** True when this provider may contribute a non-zero cache term at all (I4). */
    hasEconomics(provider) {
      return registry.get(provider).mechanism !== "none";
    },
  };

  return Object.freeze(registry);
}

/**
 * The startup summary and `dxrouter cost --pricing` body — one function, so the two can
 * never disagree about what the loader resolved.
 */
export function describePricing(registry, { width = 12 } = {}) {
  const head = [
    "PROVIDER".padEnd(width),
    "STATUS".padEnd(16),
    "MECHANISM".padEnd(10),
    "VERIFIED".padEnd(18),
    "DETAIL",
  ].join(" ");
  const lines = registry.rows.map((r) => {
    const status = r.status === PRICING_STATUS.DISABLED ? `disabled:${r.cause}` : r.status;
    const verified = r.verified_at === null ? "-" : `${new Date(r.verified_at).toISOString().slice(0, 10)} (${r.age_days}d)`;
    return [
      r.provider.padEnd(width),
      status.padEnd(16),
      r.mechanism.padEnd(10),
      verified.padEnd(18),
      r.detail ?? "",
    ]
      .join(" ")
      .trimEnd();
  });
  const { ok, stale, disabled, total } = registry.counts;
  return [head, ...lines, `${total} providers: ${ok} ok, ${stale} stale, ${disabled} disabled`].join("\n");
}

export default loadCacheModels;
