/**
 * M2 group C — what actually reaches the database.
 *
 * These tests open a real SQLite file (`sql.js`, the one driver present on every
 * machine) and assert on persisted columns, because every claim M2 makes is a claim
 * about stored state: that a `confirmed` row carries provider evidence, that a silent
 * provider leaves NULL rather than 0, that no request content has a column to live in,
 * and that an M1 database upgrades in place without losing a row.
 *
 * The privacy check is a scan of every value in every M2 table against the content the
 * request actually carried. That is deliberately blunt: a column added later with no
 * thought about §14 fails it without anyone having to remember to update a list.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";

import { CACHE_CONFIDENCE, CACHE_EVIDENCE, PROVIDER_EVIDENCE } from "../../continuity/cache/confidence.js";
import { NO_ENTRIES, RESULT_STATUS, observeCacheResult } from "../../continuity/cache/observer.js";
import { createCachePolicy, DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { createCacheLedger } from "../../continuity/cache/ledger.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { sweepSessions } from "../../continuity/session/sweeper.js";
import { MIGRATIONS, latestVersion } from "../../continuity/store/sqlite/migrations/index.js";
import m003 from "../../continuity/store/sqlite/migrations/003-cache-m2.js";
import { migrateContinuityStore, openContinuityStore } from "../../continuity/store/index.js";
import { TOKEN_PROVENANCE } from "../../continuity/prefix/tokens.js";

import { SYSTEM, TOOLS, makeTmpDir, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const NOW = 1_700_000_000_000;

const VENDOR_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
  // 1 rather than 1024: eligibility is the estimator's subject (group A), and pinning it
  // here would make a persistence test fail whenever a fixture's byte count moved.
  "min_cacheable_tokens: 1",
  "ttl_default_s: 300",
  "write_multiplier_default: 1.25",
  "read_multiplier: 0.1",
  "reports_cache_read: true",
  "reports_cache_write: true",
  "verification_method: documentation",
  "verified_at: 2023-11-10",
  "verified_by: test fixture",
  "source: https://example.invalid/docs",
  "version: 1",
].join("\n");

const DEFAULT_YAML = ["provider: default", "mechanism: none", "version: 1"].join("\n");

function registry(now = NOW) {
  return loadCacheModels({
    source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }),
    now,
    policy: DEFAULT_CACHE_POLICY,
  });
}

/** The long-ish request used throughout, so the prefix has something to cache. */
const CHAT = messages(120, "persist ");

function record(h, observation, { usage = {}, status = RESULT_STATUS.OK, pricingKey = "vendor", ...rest } = {}) {
  return observeCacheResult({
    store: h.store,
    clock: h.clock,
    registry: registry(),
    observation,
    result: {
      provider: "vendor-alias",
      pricing_key: pricingKey,
      model: "vendor-model",
      status,
      http_status: status === RESULT_STATUS.OK ? 200 : 500,
      usage,
      at: h.at(),
      ...rest,
    },
  });
}

const rows = (h, sql, args = []) => h.db.all(sql, args) || [];
const one = (h, sql, args = []) => h.db.get(sql, args) ?? null;

describe("C — migrations reach M2 without touching what M1 stored", () => {
  let dir;
  afterEach(() => dir && removeTmpDir(dir));

  it("stamps a fresh database at the latest version with the M2 tables present", async () => {
    dir = makeTmpDir("m2-fresh");
    const h = await openHarness({ dir });
    // Derived from the migration list, not written down: a later milestone appending a
    // migration should not have to edit an M2 test to keep it true. What this asserts is
    // that a fresh database lands on the version this build knows about, in one step.
    expect(h.store.schemaVersion).toBe(latestVersion());
    expect(h.store.migration).toMatchObject({ from: 0, to: latestVersion(), fresh: true });
    expect(h.store.tables).toContain("turn_results");
    // The repositories M2 owns are reachable from the handle, which is what keeps the
    // engine from opening its own connection anywhere.
    for (const repo of ["cache", "turnResults", "experiments", "fixtures"]) {
      expect(typeof h.store[repo]).toBe("object");
    }
    h.close();
  });

  it("upgrades an M1 database in place, keeping every row", async () => {
    dir = makeTmpDir("m2-upgrade");
    const file = `${dir}/upgrade.sqlite`;
    const db = await createSqlJsAdapter(file);

    // Stop at 002: an M1 install, before this milestone existed.
    const m1 = migrateContinuityStore(db, { migrations: MIGRATIONS.slice(0, 2) });
    expect(m1).toMatchObject({ from: 0, to: 2 });
    db.run(
      `INSERT INTO sessions (id, project_root, identity_confidence, identity_source, opened_at, last_seen_at, turn_count, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["sess-m1", "hashed-root", "strong", "session_key", NOW, NOW, 1, "active"],
    );
    expect(() => db.all(`SELECT * FROM turn_results`)).toThrow();

    const store = openContinuityStore({ db });
    expect(store.migration).toMatchObject({
      from: 2,
      to: latestVersion(),
      applied: latestVersion() - 2,
      fresh: false,
    });
    // The M1 row is still there — no rebuild, no back-fill, no drop.
    expect(db.get(`SELECT id, turn_count FROM sessions WHERE id = ?`, ["sess-m1"])).toMatchObject({
      id: "sess-m1",
      turn_count: 1,
    });
    expect(db.all(`SELECT * FROM turn_results`)).toEqual([]);

    const cacheColumns = new Set(db.all(`PRAGMA table_info(cache_entries)`).map((r) => r.name));
    for (const col of ["mechanism", "evidence", "tokens_provenance", "pricing_version", "confirmed_at", "reads_observed"]) {
      expect(cacheColumns, col).toContain(col);
    }
    const fixtureColumns = new Set(db.all(`PRAGMA table_info(fixtures)`).map((r) => r.name));
    expect(fixtureColumns).toContain("source");
    expect(fixtureColumns).toContain("content_hash");

    // Whatever a fixture row omits, it is never silently `captured` (§15).
    const dflt = db.all(`PRAGMA table_info(fixtures)`).find((r) => r.name === "source");
    expect(String(dflt.dflt_value)).toMatch(/synthetic/);
    db.close();
  });

  it("leaves attempts.decision_id alone rather than rebuilding a released table", async () => {
    // The documented mismatch: §12 puts observed results in `attempts`, whose
    // `decision_id` is NOT NULL, and M2 produces no Decision. `turn_results` exists
    // because relaxing that column would be the destructive step §12.3 forbids.
    dir = makeTmpDir("m2-attempts");
    const h = await openHarness({ dir });
    const decisionId = h.db.all(`PRAGMA table_info(attempts)`).find((r) => r.name === "decision_id");
    expect(decisionId.notnull).toBeTruthy();
    expect(h.db.all(`SELECT * FROM attempts`)).toEqual([]);
    h.close();
  });

  it("can re-run migration 003 on an already-migrated database", async () => {
    // Not a theoretical property: a half-applied migration is what a killed process
    // leaves behind, and the recovery path is to run it again.
    dir = makeTmpDir("m2-rerun");
    const h = await openHarness({ dir });
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { input: 100, cache_read: 0, cache_write: 900 } });
    const before = one(h, `SELECT COUNT(*) AS n FROM cache_entries`).n;
    expect(Number(before)).toBeGreaterThan(0);

    expect(() => h.db.transaction(() => m003.up(h.db))).not.toThrow();
    expect(Number(one(h, `SELECT COUNT(*) AS n FROM cache_entries`).n)).toBe(Number(before));
    expect(h.db.all(`SELECT * FROM turn_results`)).toHaveLength(1);
    h.close();
  });
});

describe("C — one observed result, as it lands in the tables", () => {
  let h;
  beforeEach(async () => {
    h = await openHarness({ tag: "m2-observe" });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  it("writes one turn_results row and the cache entries the plan implies", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    const out = record(h, obs, { usage: { input: 4000, output: 200, cache_read: 0, cache_write: 4000 }, attempt_id: null });

    expect(out.observed).toBe(true);
    expect(out.skipped).toBe(null);
    expect(out.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(out.evidence).toBe(CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE);

    const result = one(h, `SELECT * FROM turn_results`);
    expect(result).toMatchObject({
      session_id: obs.session_id,
      turn_idx: obs.turn_idx,
      seq: 0,
      // The alias is recorded as the provider; the vendor it was priced against is a
      // separate column, so a later reader can tell which of the two a number came from.
      provider: "vendor-alias",
      pricing_key: "vendor",
      mechanism: "explicit",
      cache_confidence: CACHE_CONFIDENCE.CONFIRMED,
      usage_provenance: TOKEN_PROVENANCE.MEASURED,
      status: RESULT_STATUS.OK,
      http_status: 200,
    });
    // The forward link to M3's `attempts` row, empty in M2 by construction.
    expect(result.attempt_id).toBe(null);

    const entries = rows(h, `SELECT * FROM cache_entries ORDER BY layer`);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.provider).toBe("vendor");
      expect(e.model).toBe("vendor-model");
      expect(e.ttl_s).toBe(300);
      expect(e.pricing_version).toBe("1");
      expect(e.tokens_provenance).toBe(TOKEN_PROVENANCE.ESTIMATED);
      expect(e.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
      expect(e.evidence).toBe(CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE);
      expect(e.writes_observed).toBe(1);
      expect(e.reads_observed).toBe(0);
    }
  });

  it("stores every persisted confirmed row with provider evidence (I3, as an audit)", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_write: 4000 } });
    const obs2 = await h.observe(turnRequest({ msgs: [...CHAT, { role: "user", content: "more" }] }));
    record(h, obs2, { usage: { cache_read: 100 } });
    record(h, obs2, { usage: {} });

    // The query an auditor would write, run against real rows rather than against a mock.
    const bad = rows(
      h,
      `SELECT layer, evidence FROM cache_entries WHERE confidence = 'confirmed' AND evidence NOT IN (?, ?)`,
      PROVIDER_EVIDENCE,
    );
    expect(bad).toEqual([]);
    const badResults = rows(
      h,
      `SELECT seq FROM turn_results WHERE cache_confidence = 'confirmed'
        AND usage_cache_read IS NULL AND usage_cache_write IS NULL`,
    );
    expect(badResults).toEqual([]);
  });

  it("distinguishes a reported zero from silence in the stored columns", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { input: 10, cache_read: 0, cache_write: 0 } });
    h.tick(1000);
    record(h, obs, { usage: { input: 10 } });

    const [reported, silent] = rows(h, `SELECT * FROM turn_results ORDER BY seq`);
    // 0 means "the provider said no read happened". NULL means "the provider said
    // nothing". Collapsing the two would make the coverage measure unanswerable.
    expect(reported.usage_cache_read).toBe(0);
    expect(reported.usage_cache_write).toBe(0);
    expect(silent.usage_cache_read).toBe(null);
    expect(silent.usage_cache_write).toBe(null);
    expect(reported.cache_confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    expect(silent.cache_confidence).toBe(CACHE_CONFIDENCE.ASSUMED);
    // Same confidence, different evidence — which is the pair the audit needs.
    const entries = rows(h, `SELECT DISTINCT evidence FROM cache_entries`);
    expect(entries.map((e) => e.evidence)).toEqual([CACHE_EVIDENCE.ASSUMED_WRITE]);
    expect(silent.usage_provenance).toBe(TOKEN_PROVENANCE.MEASURED);
  });

  it("records a result with no usage at all as unavailable, not as zero", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: {} });
    const result = one(h, `SELECT * FROM turn_results`);
    expect(result.usage_provenance).toBe(TOKEN_PROVENANCE.UNAVAILABLE);
    expect(result.usage_in).toBe(null);

    // The same result written the way the adapter actually writes it: every field
    // *present* and null, because `toEngineUsage` fills the shape in whether or not the
    // provider said anything. `Number(null)` is 0 and 0 is finite, so a careless coercion
    // stores four measured zeros here — and then `usage_cache_read IS NULL` finds no
    // silent results at all and the §19.4 coverage measure answers the wrong question.
    // An explicit null must read exactly like an omitted field.
    h.tick(1000);
    const out = record(h, obs, { usage: { input: null, output: null, cache_read: null, cache_write: null } });
    expect(out.provider_reported).toBe(false);
    expect(out.evidence).toBe(CACHE_EVIDENCE.PROVIDER_SILENT);
    const explicit = rows(h, `SELECT * FROM turn_results ORDER BY seq`)[1];
    expect(explicit.usage_provenance).toBe(TOKEN_PROVENANCE.UNAVAILABLE);
    expect([explicit.usage_in, explicit.usage_out, explicit.usage_cache_read, explicit.usage_cache_write]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("claims nothing for a provider with no cache model, but still records the turn", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    const out = record(h, obs, { pricingKey: "a-provider-nobody-documented", usage: { input: 10 } });
    expect(out.mechanism).toBe("none");
    expect(out.skipped).toBe(NO_ENTRIES.NO_CACHE_MODEL);
    expect(out.confidence).toBe(CACHE_CONFIDENCE.UNKNOWN);
    expect(out.labels).toContain("cache-model-unavailable");
    // Zero claimed economics (I4) — and a row that says so, so the gap is visible.
    expect(rows(h, `SELECT * FROM cache_entries`)).toEqual([]);
    const result = one(h, `SELECT * FROM turn_results`);
    expect(result.cache_confidence).toBe(CACHE_CONFIDENCE.UNKNOWN);
    expect(result.mechanism).toBe("none");
    expect(result.labels).toBe("cache-model-unavailable");
  });

  it("writes no entry for a failed attempt but keeps the failure", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    const out = record(h, obs, { status: RESULT_STATUS.ERROR, usage: { cache_read: 500 } });
    expect(out.skipped).toBe(NO_ENTRIES.ATTEMPT_FAILED);
    expect(rows(h, `SELECT * FROM cache_entries`)).toEqual([]);
    expect(one(h, `SELECT status, http_status FROM turn_results`)).toMatchObject({
      status: RESULT_STATUS.ERROR,
      http_status: 500,
    });
  });

  it("accumulates counters across turns and never sums tokens", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_write: 4000 } });
    const first = one(h, `SELECT * FROM cache_entries WHERE layer = 'tools'`);

    h.tick(60_000);
    const obs2 = await h.observe(turnRequest({ msgs: [...CHAT, { role: "assistant", content: "ok" }] }));
    // The tools layer is unchanged, and now the provider reports reading it back.
    record(h, obs2, { usage: { cache_read: 1_000_000 } });
    const second = one(h, `SELECT * FROM cache_entries WHERE layer = 'tools'`);

    expect(second.tokens).toBe(first.tokens);
    expect(second.reads_observed).toBe(1);
    expect(second.writes_observed).toBe(first.writes_observed);
    expect(second.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    // A reported read restarts the window, because the provider just said the material
    // is live.
    expect(second.written_at).toBe(first.written_at + 60_000);
    expect(second.confirmed_at).toBe(first.written_at + 60_000);
    // One row per (provider, model, prefix_hash, layer): the unchanged layer was
    // updated, not duplicated.
    expect(Number(one(h, `SELECT COUNT(*) AS n FROM cache_entries WHERE layer = 'tools'`).n)).toBe(1);
  });

  it("keeps the evidence that earned a confirmation when a later turn is silent", async () => {
    // The most ordinary sequence there is: the provider reports a write, then says
    // nothing next turn. `raiseWithEvidence` does not demote the row — the report did
    // happen — so the evidence column must go on naming that report. Storing the newer,
    // weaker evidence beside `confirmed` would be an I3 violation on the face of the
    // row, and `assertConfidenceEvidence` rejects it, so it would also throw straight
    // out of the observation.
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_write: 4000 } });
    h.tick(1000);
    expect(() => record(h, obs, { usage: { input: 10 } })).not.toThrow();

    const row = one(h, `SELECT * FROM cache_entries WHERE layer = 'tools'`);
    expect(row.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(row.evidence).toBe(CACHE_EVIDENCE.PROVIDER_REPORTED_WRITE);
    // The silent turn still moved the window and the row's clock, so "confirmed once,
    // a while ago" stays distinguishable from "confirmed just now".
    expect(row.confirmed_at).toBe(NOW);
    expect(row.updated_at).toBe(NOW + 1000);
    expect(row.writes_observed).toBe(1);
  });

  it("declines quietly when M1 recorded no turn", () => {
    // Sessions off, or the M1 observer failed open. Inventing a session here would
    // create continuity state out of a response.
    expect(record(h, { session_id: null, turn_idx: null })).toMatchObject({
      observed: false,
      reason: "no_observed_turn",
    });
    expect(rows(h, `SELECT * FROM turn_results`)).toEqual([]);
  });

  it("refuses to run without a store or a registry", () => {
    expect(() => observeCacheResult({ clock: h.clock, registry: registry() })).toThrow(/open store/);
    expect(() => observeCacheResult({ store: h.store, clock: h.clock })).toThrow(/I4/);
  });

  it("numbers repeated results for one turn instead of overwriting", async () => {
    // Multi-account fallback: one turn, several upstream attempts.
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { status: RESULT_STATUS.ERROR, usage: {} });
    h.tick(500);
    record(h, obs, { usage: { cache_write: 4000 } });
    expect(rows(h, `SELECT seq, status FROM turn_results ORDER BY seq`).map((r) => r.seq)).toEqual([0, 1]);
  });
});

describe("C — the belief survives a restart", () => {
  it("reads persisted rows back into the same ledger answer", async () => {
    const dir = makeTmpDir("m2-restart");
    const first = await openHarness({ dir, name: "cont" });
    const obs = await first.observe(turnRequest({ msgs: CHAT }));
    record(first, obs, { usage: { cache_write: 4000 } });
    const written = Number(one(first, `SELECT COUNT(*) AS n FROM cache_entries`).n);
    first.close();

    // A second process, a fresh handle on the same file.
    const db = await createSqlJsAdapter(first.file);
    const store = openContinuityStore({ db });
    expect(store.migration.applied).toBe(0);
    const hashes = ["tools", "system", "messages"].map((l) => obs.layers[`${l}_hash`]);
    const entries = store.cache.listCacheEntriesForHashes(db, "vendor", "vendor-model", hashes);
    expect(entries).toHaveLength(written);

    const ledger = createCacheLedger({ entries, registry: registry(), now: NOW });
    const belief = ledger.describeBelief({ provider: "vendor", model: "vendor-model", layers: obs.layers });
    expect(belief.warm_prefix).toEqual(["tools", "system", "messages"]);
    expect(belief.confidence).toBe(CACHE_CONFIDENCE.CONFIRMED);
    expect(belief.warm_tokens_provenance).toBe("confirmed");
    db.close();
    removeTmpDir(dir);
  });
});

describe("C — the coverage question, answered from stored rows", () => {
  let h;
  beforeEach(async () => {
    h = await openHarness({ tag: "m2-coverage" });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  it("counts silent-but-assumed separately from reported reads", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_read: 500, cache_write: 100 } });
    h.tick(1000);
    record(h, obs, { usage: { input: 10 } });
    h.tick(1000);
    record(h, obs, { usage: { input: 10 } });

    const [row] = h.store.turnResults.cacheReportingCoverage(h.db, { since: 0 });
    expect(row).toMatchObject({
      provider: "vendor-alias",
      total: 3,
      reported_read: 1,
      silent: 2,
      confirmed: 1,
      assumed: 2,
      // The population where cache economics would rest on `assumed` alone. This is the
      // number that decides whether Q1 can be answered at all.
      silent_but_assumed: 2,
      cache_read_tokens: 500,
    });
  });

  it("filters by provider and by time", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_read: 1 } });
    const cut = h.tick(10_000);
    record(h, obs, { usage: { cache_read: 2 } });
    expect(h.store.turnResults.cacheReportingCoverage(h.db, { since: cut })[0].total).toBe(1);
    expect(h.store.turnResults.cacheReportingCoverage(h.db, { since: 0, provider: "nobody" })).toEqual([]);
  });

  it("reports per-provider and per-confidence entry counts", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_write: 4000 } });
    const stats = h.store.cache.cacheEntryStats(h.db);
    expect(stats.every((s) => s.provider === "vendor")).toBe(true);
    expect(stats.every((s) => s.confidence === CACHE_CONFIDENCE.CONFIRMED)).toBe(true);
    expect(stats.reduce((n, s) => n + s.entries, 0)).toBe(h.store.cache.countCacheEntries(h.db));
  });
});

describe("C — retention (§12.3)", () => {
  let h;
  beforeEach(async () => {
    h = await openHarness({ tag: "m2-sweep" });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  it("keeps an expired entry visible for the grace hour, then deletes it", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_write: 4000 } });
    const before = h.store.cache.countCacheEntries(h.db);
    expect(before).toBeGreaterThan(0);

    // Past the 300 s TTL but inside the grace: "expired" and "never existed" must stay
    // distinguishable, which is the difference between a diagnosable miss and a mystery.
    const sweep = (ms) =>
      sweepSessions({ store: h.store, clock: { now: () => NOW + ms }, cachePolicy: DEFAULT_CACHE_POLICY });
    expect(sweep(600_000).cache_entries_deleted).toBe(0);
    expect(h.store.cache.countCacheEntries(h.db)).toBe(before);

    const gone = sweep(300_000 + DEFAULT_CACHE_POLICY.expiryGraceMs + 1000);
    expect(gone.cache_entries_deleted).toBe(before);
    expect(h.store.cache.countCacheEntries(h.db)).toBe(0);
  });

  it("drops turn_results past the retention window", async () => {
    const obs = await h.observe(turnRequest({ msgs: CHAT }));
    record(h, obs, { usage: { cache_read: 1 } });
    expect(h.store.turnResults.countTurnResults(h.db)).toBe(1);

    const policy = createCachePolicy({ resultRetentionDays: 30 });
    const early = sweepSessions({ store: h.store, clock: { now: () => NOW + 86_400_000 }, cachePolicy: policy });
    expect(early.turn_results_deleted).toBe(0);

    const late = sweepSessions({
      store: h.store,
      clock: { now: () => NOW + 31 * 86_400_000 },
      cachePolicy: policy,
    });
    expect(late.turn_results_deleted).toBe(1);
    expect(h.store.turnResults.countTurnResults(h.db)).toBe(0);
  });

  it("sweeps an M1-era database without a cache table rather than throwing", async () => {
    // The sweeper runs on a schedule; a database mid-upgrade must not take it down.
    const dir = makeTmpDir("m2-sweep-old");
    const db = await createSqlJsAdapter(`${dir}/old.sqlite`);
    migrateContinuityStore(db, { migrations: MIGRATIONS.slice(0, 2) });
    const store = { db, sessions: h.store.sessions, turns: h.store.turns, prefixState: h.store.prefixState };
    const out = sweepSessions({ store, clock: { now: () => NOW } });
    expect(out.cache_entries_deleted).toBe(0);
    db.close();
    removeTmpDir(dir);
  });
});

describe("C — privacy: there is no column for a prompt (§14)", () => {
  it("stores nothing from the request body in any M2 table", async () => {
    const h = await openHarness({ tag: "m2-privacy" });
    const secret = "PLEASE-DO-NOT-PERSIST-ME";
    const obs = await h.observe(
      turnRequest({
        msgs: [...CHAT, { role: "user", content: `${secret} and my API key is sk-not-a-real-key` }],
        system: `${SYSTEM} ${secret}`,
        tools: [...TOOLS, { name: secret, description: secret }],
        root: `/repo/${secret}`,
      }),
    );
    record(h, obs, { usage: { cache_read: 100, cache_write: 4000 }, reported_model: `vendor-model-${secret}` });

    const needles = [secret, "sk-not-a-real-key", SYSTEM, "persist ", "read_file"];
    for (const table of ["cache_entries", "turn_results"]) {
      const all = rows(h, `SELECT * FROM ${table}`);
      expect(all.length).toBeGreaterThan(0);
      for (const row of all) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== "string") continue;
          for (const needle of needles) {
            // `reported_model` is the one field an upstream controls, and it is echoed
            // verbatim by design; everything else must be a hash, an enum or a number.
            if (column === "reported_model") continue;
            expect(value.includes(needle), `${table}.${column} leaked ${needle}`).toBe(false);
          }
        }
      }
    }

    // The prefix hashes are hashes, not truncated content.
    for (const row of rows(h, `SELECT prefix_hash FROM cache_entries`)) {
      expect(row.prefix_hash).toMatch(/^c1:[0-9a-f]{32,}$/);
    }
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });
});
