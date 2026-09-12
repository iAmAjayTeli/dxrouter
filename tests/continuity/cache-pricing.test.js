/**
 * M2 group B — cache pricing: validation, the §9.3 degradation table, and the one thing
 * a bad pricing file must never do, which is give a provider somebody else's ratios.
 *
 * Every case in this file is a failure case that the loader has to survive, because the
 * brief's rule is that "a bad or missing provider entry must degrade that provider's
 * cache-awareness, not crash the entire router". The loader is therefore tested by
 * feeding it broken records and asserting on what it returns, never by asserting that it
 * throws.
 *
 * The shipped records are also checked, once, against the schema they claim to satisfy —
 * a committed record that no longer validates would silently disable a provider.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_PROVIDER_KEY,
  DISABLED_CAUSE,
  PRICING_LABELS,
  PRICING_STATUS,
  REQUIRED_PROVIDERS,
  YamlError,
  cacheModelVersion,
  createMemorySource,
  describePricing,
  layerSources,
  loadCacheModels,
  parseFlatYaml,
  parseVerifiedAt,
  shippedSource,
  supportsConfirmedArithmetic,
  toBasisPoints,
  validateCacheModel,
} from "../../continuity/cache/pricing/index.js";
import { createCachePolicy, DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";

/** 2023-11-14T22:13:20Z. Four days after the `verified_at` the fixtures use. */
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const GOOD = {
  provider: "vendor",
  mechanism: "explicit",
  breakpoints: 4,
  min_cacheable_tokens: 1024,
  ttl_default_s: 300,
  ttl_extended_s: 3600,
  write_multiplier_default: 1.25,
  write_multiplier_extended: 2.0,
  read_multiplier: 0.1,
  reports_cache_read: true,
  reports_cache_write: true,
  verification_method: "documentation",
  verified_at: "2023-11-10",
  verified_by: "test fixture",
  source: "https://example.invalid/docs",
  version: 1,
};

function yaml(record) {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
}

const DEFAULT_YAML = yaml({ provider: "default", mechanism: "none", version: 1 });

function load(records, { now = NOW, policy = DEFAULT_CACHE_POLICY, keys = [] } = {}) {
  return loadCacheModels({ source: createMemorySource({ default: DEFAULT_YAML, ...records }), now, policy, keys });
}

const rowFor = (registry, provider) => registry.rows.find((r) => r.provider === provider);
const diagnosticsFor = (registry, provider) => registry.diagnostics.filter((d) => d.provider === provider);

describe("B — the flat-subset YAML reader refuses what it cannot represent", () => {
  it("reads scalars, booleans, numbers and quoted strings", () => {
    const parsed = parseFlatYaml(
      ['provider: vendor', "ttl_default_s: 300", "reports_cache_read: true", 'notes: "a: colon, inside"'].join("\n"),
    );
    expect(parsed).toEqual({
      provider: "vendor",
      ttl_default_s: 300,
      reports_cache_read: true,
      notes: "a: colon, inside",
    });
  });

  it("rejects nesting, duplicate keys and a missing colon rather than guessing", () => {
    // A reader that guessed would turn a typo into a silently different cache model.
    for (const text of ["a:\n  b: 1", "provider: x\nprovider: y", "just a line"]) {
      expect(() => parseFlatYaml(text)).toThrow(YamlError);
    }
  });

  it("reports the line number, so a malformed record can be fixed", () => {
    try {
      parseFlatYaml("provider: vendor\nprovider: other");
      throw new Error("expected a YamlError");
    } catch (err) {
      expect(err).toBeInstanceOf(YamlError);
      expect(err.line).toBe(2);
    }
  });
});

describe("B — record validation", () => {
  it("accepts a complete record and exposes integer basis points", () => {
    const { ok, model } = validateCacheModel(GOOD, { provider: "vendor" });
    expect(ok).toBe(true);
    // Money will be integer micro-USD, so the conversion lives with the record rather
    // than in whichever module first needs it.
    expect(model.read_multiplier_bp).toBe(1000);
    expect(model.write_multiplier_default_bp).toBe(12_500);
    expect(model.write_multiplier_extended_bp).toBe(20_000);
    expect(model.verified_at).toBe(Date.parse("2023-11-10T00:00:00Z"));
    expect(toBasisPoints(null)).toBe(null);
    expect(toBasisPoints(-1)).toBe(null);
  });

  it("refuses a record whose provider is not the key it was loaded as", () => {
    // This is the mix-up that would give one vendor another vendor's ratios, so it is a
    // hard validation failure rather than a warning.
    const out = validateCacheModel({ ...GOOD, provider: "other" }, { provider: "vendor" });
    expect(out.ok).toBe(false);
    expect(out.cause).toBe(DISABLED_CAUSE.MALFORMED);
    expect(out.detail).toMatch(/loaded as vendor/);
  });

  it("refuses half a cache model", () => {
    const missing = {
      ttl_default_s: "ttl_default_s",
      read_multiplier: "read_multiplier",
      write_multiplier_default: "write_multiplier_default",
      breakpoints: "breakpoints",
    };
    for (const [field, expected] of Object.entries(missing)) {
      const out = validateCacheModel({ ...GOOD, [field]: undefined }, { provider: "vendor" });
      expect(out.ok, `${field} should be required`).toBe(false);
      expect(out.field).toBe(expected);
    }
    // Extended terms are a pair: a TTL with no multiplier prices nothing.
    expect(validateCacheModel({ ...GOOD, write_multiplier_extended: undefined }, { provider: "vendor" }).ok).toBe(false);
  });

  it("disables an unverified record instead of reading it leniently (§9.3)", () => {
    for (const field of ["verified_at", "verified_by"]) {
      const out = validateCacheModel({ ...GOOD, [field]: undefined }, { provider: "vendor" });
      expect(out.ok).toBe(false);
      // `unverified`, not `malformed`: the numbers may be fine, but nobody stands behind
      // them, and an unverifiable record must not become a lenient one.
      expect(out.cause).toBe(DISABLED_CAUSE.UNVERIFIED);
    }
  });

  it("exempts a mechanism: none record from verification metadata", () => {
    // Otherwise the one entry whose loss is a hard failure would become a routine one.
    const out = validateCacheModel({ provider: "default", mechanism: "none", version: 1 }, { provider: "default" });
    expect(out.ok).toBe(true);
    expect(out.model.verified_by).toBe(null);
  });

  it("rejects out-of-contract values without inventing a substitute", () => {
    const cases = [
      { mechanism: "sometimes" },
      { ttl_default_s: -1 },
      { min_cacheable_tokens: "lots" },
      { reports_cache_read: "yes" },
      { breakpoints: 1.5 },
      { breakpoints: [1, 2] },
      { verification_method: "vibes" },
      { verified_at: "last tuesday" },
    ];
    for (const patch of cases) {
      expect(validateCacheModel({ ...GOOD, ...patch }, { provider: "vendor" }).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("defaults an absent verification_method to the weaker of the two", () => {
    const { model } = validateCacheModel({ ...GOOD, verification_method: undefined }, { provider: "vendor" });
    expect(model.verification_method).toBe("documentation");
    // A documented ratio can never be reported as a measured one by omission.
    expect(supportsConfirmedArithmetic(model)).toBe(false);
    const probed = validateCacheModel({ ...GOOD, verification_method: "probe" }, { provider: "vendor" }).model;
    expect(supportsConfirmedArithmetic(probed)).toBe(true);
    expect(supportsConfirmedArithmetic({ mechanism: "none", verification_method: "probe" })).toBe(false);
  });

  it("treats an absent reports_cache_* as no claim rather than as false evidence", () => {
    const { model } = validateCacheModel(
      { ...GOOD, reports_cache_read: undefined, reports_cache_write: undefined },
      { provider: "vendor" },
    );
    // Understating rather than inventing: the field says what the record claims, and a
    // silent record claims nothing.
    expect(model.reports_cache_read).toBe(false);
    expect(model.reports_cache_write).toBe(false);
  });

  it("parses only real ISO dates", () => {
    expect(parseVerifiedAt("2023-11-10")).toBe(Date.parse("2023-11-10T00:00:00Z"));
    expect(parseVerifiedAt("2023-11-10 08:30")).toBe(Date.parse("2023-11-10T08:30"));
    for (const bad of ["", "  ", "10/11/2023", "2023-11", null, 42]) expect(parseVerifiedAt(bad)).toBe(null);
  });
});

describe("B — the §9.3 loader table, one row at a time", () => {
  it("reports a fresh verified record as ok", () => {
    const registry = load({ vendor: yaml(GOOD) });
    expect(registry.statusOf("vendor")).toMatchObject({ status: PRICING_STATUS.OK, cause: null });
    expect(registry.get("vendor").mechanism).toBe("explicit");
    expect(registry.labelsFor("vendor")).toEqual([]);
    expect(registry.hasEconomics("vendor")).toBe(true);
    expect(diagnosticsFor(registry, "vendor")).toEqual([]);
  });

  it("downgrades a record older than 90 days to stale and keeps using it", () => {
    // Stale is not disabled: the ratios are probably still right, and refusing to use
    // them would cost more accuracy than the staleness does. What changes is the label.
    const registry = load({ vendor: yaml(GOOD) }, { now: NOW + 120 * DAY });
    expect(registry.statusOf("vendor").status).toBe(PRICING_STATUS.STALE);
    expect(registry.get("vendor").mechanism).toBe("explicit");
    expect(registry.labelsFor("vendor")).toEqual([PRICING_LABELS.STALE]);
    expect(registry.hasEconomics("vendor")).toBe(true);
    expect(diagnosticsFor(registry, "vendor")[0]).toMatchObject({ level: "warn" });
    expect(rowFor(registry, "vendor").age_days).toBe(124);
  });

  it("honours a policy that moves the staleness horizon", () => {
    const registry = load({ vendor: yaml(GOOD) }, { policy: createCachePolicy({ maxAgeDays: 1 }) });
    expect(registry.statusOf("vendor").status).toBe(PRICING_STATUS.STALE);
  });

  it("disables a malformed record and never lets it borrow a neighbour's terms", () => {
    const registry = load({ vendor: "provider: vendor\n  nested: 1", anthropic: yaml({ ...GOOD, provider: "anthropic" }) });
    const status = registry.statusOf("vendor");
    expect(status.status).toBe(PRICING_STATUS.DISABLED);
    expect(status.cause).toBe(DISABLED_CAUSE.MALFORMED);
    const model = registry.get("vendor");
    // The record it gets is a real, routable one whose mechanism is none — an absence
    // would have to be handled by every caller, and a fallback to anthropic's 0.1 read
    // multiplier is the exact I4 violation this test exists to catch.
    expect(model.mechanism).toBe("none");
    expect(model.read_multiplier).toBe(null);
    expect(model.disabled_cause).toBe(DISABLED_CAUSE.MALFORMED);
    expect(registry.get("anthropic").read_multiplier).toBe(0.1);
    expect(registry.hasEconomics("vendor")).toBe(false);
    expect(registry.labelsFor("vendor")).toEqual([PRICING_LABELS.UNAVAILABLE]);
    expect(diagnosticsFor(registry, "vendor")[0].level).toBe("error");
  });

  it("disables a record that fails the schema, with the field in the detail", () => {
    const registry = load({ vendor: yaml({ ...GOOD, mechanism: "occasionally" }) });
    expect(registry.statusOf("vendor")).toMatchObject({ status: PRICING_STATUS.DISABLED, cause: DISABLED_CAUSE.MALFORMED });
    expect(registry.statusOf("vendor").detail).toMatch(/mechanism/);
  });

  it("reports a missing file as missing, at info level", () => {
    const registry = load({});
    expect(registry.statusOf("openai")).toMatchObject({
      status: PRICING_STATUS.DISABLED,
      cause: DISABLED_CAUSE.MISSING,
    });
    expect(registry.get("openai").mechanism).toBe("none");
    // Info, not error: a provider we have not documented yet is a known gap, not a bug.
    expect(diagnosticsFor(registry, "openai")[0].level).toBe("info");
  });

  it("gives an unknown provider the default record, not a neighbour's", () => {
    const registry = load({ vendor: yaml(GOOD) });
    const unknown = registry.get("a-provider-nobody-documented");
    expect(unknown.provider).toBe(DEFAULT_PROVIDER_KEY);
    expect(unknown.mechanism).toBe("none");
    expect(registry.hasEconomics("a-provider-nobody-documented")).toBe(false);
    // `statusOf` for a key never loaded still answers, so no caller has to null-check.
    expect(registry.statusOf("a-provider-nobody-documented")).toMatchObject({
      status: PRICING_STATUS.DISABLED,
      cause: DISABLED_CAUSE.MISSING,
    });
    // `get` is never null. That is the property every other module leans on.
    expect(registry.get(null).mechanism).toBe("none");
    expect(registry.get(undefined).mechanism).toBe("none");
  });

  it("is case-insensitive about provider keys", () => {
    const registry = load({ vendor: yaml(GOOD) });
    expect(registry.get("VENDOR").mechanism).toBe("explicit");
    expect(registry.statusOf("Vendor").status).toBe(PRICING_STATUS.OK);
  });

  it("synthesizes a broken default in memory rather than failing to start", () => {
    // The one hard failure in §9.3, handled by synthesis: without a `default` record
    // every unknown provider would have no record at all, and `get()` would start
    // returning null.
    const registry = loadCacheModels({
      source: createMemorySource({ default: "provider: default\n  broken", vendor: yaml(GOOD) }),
      now: NOW,
    });
    expect(registry.get("default")).toMatchObject({ mechanism: "none", version: "synthetic-1" });
    expect(registry.statusOf("default")).toMatchObject({ status: PRICING_STATUS.OK, detail: "synthesized in memory" });
    // Recorded as an error even though the load succeeded, so the operator fixes the file.
    const diag = diagnosticsFor(registry, "default")[0];
    expect(diag.level).toBe("error");
    expect(diag.message).toMatch(/synthesized in memory/);
    // And the rest of the registry is unaffected.
    expect(registry.get("vendor").mechanism).toBe("explicit");
  });

  it("treats a mechanism: none record as ok rather than as stale", () => {
    // It claims nothing, so there is nothing for age to erode; the mechanism column
    // already says it contributes zero.
    const registry = load({ vendor: yaml({ provider: "vendor", mechanism: "none", version: 1 }) }, { now: NOW + 900 * DAY });
    expect(registry.statusOf("vendor").status).toBe(PRICING_STATUS.OK);
    expect(registry.labelsFor("vendor")).toEqual([PRICING_LABELS.UNAVAILABLE]);
    expect(registry.hasEconomics("vendor")).toBe(false);
  });
});

describe("B — the registry as a whole", () => {
  it("always resolves the default key and the ten §9.2 providers", () => {
    const registry = load({});
    for (const key of [DEFAULT_PROVIDER_KEY, ...REQUIRED_PROVIDERS]) expect(registry.keys).toContain(key);
    expect(registry.rows.filter((r) => r.required)).toHaveLength(REQUIRED_PROVIDERS.length);
  });

  it("counts every row into exactly one bucket", () => {
    const registry = load({ vendor: yaml(GOOD), broken: "nope: [" });
    const { ok, stale, disabled, total } = registry.counts;
    expect(total).toBe(registry.rows.length);
    expect(ok + stale + disabled).toBe(total);
  });

  it("reports strict failures as data instead of refusing to boot", () => {
    // Whether a bad pricing record stops the process is a host decision; the engine's
    // job is to say which named provider failed.
    const registry = load({ vendor: "broken: [" }, { policy: createCachePolicy({ strictProviders: ["vendor"] }) });
    expect(registry.strictFailures).toEqual(["vendor"]);
    // Still a usable registry — nothing threw.
    expect(registry.get("vendor").mechanism).toBe("none");
    expect(load({ vendor: yaml(GOOD) }).strictFailures).toEqual([]);
  });

  it("versions the resolved set by content, so a pricing fix is visible downstream", () => {
    const a = load({ vendor: yaml(GOOD) }).version;
    expect(a).toMatch(/^cm1:\d+:[0-9a-f]{16}$/);
    // Same inputs, same version: the string is what a later Decision records, so it has
    // to be stable across runs or a replay could never be reproduced.
    expect(load({ vendor: yaml(GOOD) }).version).toBe(a);
    // A term change moves it.
    expect(load({ vendor: yaml({ ...GOOD, version: 2 }) }).version).not.toBe(a);
    // So does a status change, which is the case that matters: a provider that quietly
    // became disabled must not share a version with the run where it worked.
    expect(load({ vendor: "broken: [" }).version).not.toBe(a);
    // Order of the underlying rows must not matter.
    expect(cacheModelVersion([{ provider: "a", status: "ok", version: "1", mechanism: "none" }])).toBe(
      cacheModelVersion([{ provider: "a", status: "ok", version: "1", mechanism: "none" }]),
    );
  });

  it("renders one table for both the startup summary and `cost --pricing`", () => {
    const text = describePricing(load({ vendor: yaml(GOOD) }));
    expect(text).toMatch(/PROVIDER\s+STATUS\s+MECHANISM\s+VERIFIED\s+DETAIL/);
    expect(text).toMatch(/vendor\s+ok\s+explicit\s+2023-11-10 \(4d\)/);
    expect(text).toMatch(/providers: \d+ ok, \d+ stale, \d+ disabled$/);
    expect(describePricing(load({ vendor: "broken: [" }))).toMatch(/vendor\s+disabled:malformed\s+none/);
  });
});

describe("B — an operator can correct a record without a release (§9.2)", () => {
  it("lets a later source shadow an earlier one, key by key", () => {
    const shipped = createMemorySource({ default: DEFAULT_YAML, vendor: yaml(GOOD) }, { name: "shipped" });
    const override = createMemorySource({ vendor: yaml({ ...GOOD, read_multiplier: 0.25, version: 9 }) }, { name: "override" });
    const registry = loadCacheModels({ source: layerSources(shipped, override), now: NOW });
    expect(registry.get("vendor").read_multiplier).toBe(0.25);
    // Which layer answered is reported, so an override is never invisible.
    expect(rowFor(registry, "vendor").origin).toBe("override");
    expect(rowFor(registry, "default").origin).toBe("shipped");
  });

  it("survives an override directory that does not exist", () => {
    // The normal case: most installs have no override layer at all.
    const registry = loadCacheModels({ source: layerSources(shippedSource(), null), now: NOW });
    expect(registry.get("anthropic").mechanism).toBe("explicit");
  });
});

describe("B — the shipped records still satisfy the schema they claim", () => {
  const registry = loadCacheModels({ source: shippedSource(), now: NOW });

  it("loads every committed record without a malformed or unverified cause", () => {
    const bad = registry.rows.filter((r) => r.status === PRICING_STATUS.DISABLED && r.cause !== DISABLED_CAUSE.MISSING);
    expect(bad.map((r) => `${r.provider}:${r.cause}:${r.detail}`)).toEqual([]);
  });

  it("ships a default entry that claims nothing", () => {
    expect(registry.get(DEFAULT_PROVIDER_KEY)).toMatchObject({ mechanism: "none", provider: "default" });
    expect(diagnosticsFor(registry, "default")).toEqual([]);
  });

  it("labels every shipped record as documentation, not as a measurement", () => {
    // Nothing in this repository was probed against a live provider. A record claiming
    // `probe` would let a documented ratio be reported later as a measured one.
    const claimed = registry.rows.filter((r) => r.verification_method === "probe");
    expect(claimed.map((r) => r.provider)).toEqual([]);
    for (const row of registry.rows.filter((r) => r.mechanism !== "none")) {
      expect(row.verified_by, `${row.provider} must name who verified it`).toBeTruthy();
      expect(row.source, `${row.provider} must cite a source`).toBeTruthy();
    }
  });

  it("covers the ten providers §9.2 requires before M3", () => {
    const missing = REQUIRED_PROVIDERS.filter((p) => registry.statusOf(p).cause === DISABLED_CAUSE.MISSING);
    expect(missing).toEqual([]);
  });
});
