/**
 * M2 group E — the two new CLI commands (§13).
 *
 * `dxrouter cost` is the human-readable answer to the M2 question, so the tests here are
 * mostly about what the text is not allowed to say: no total that adds `assumed` to
 * `confirmed` (I3), no `0` where the truth is "no cache model" (I4), and no request
 * content anywhere in `--json`. `dxrouter measure` gets the same treatment for verdicts —
 * a recorded run must read as ungraded until a person grades it.
 *
 * The last block spawns the real script under bare node. That is the only way to prove
 * the money guard actually guards: `cache_probe` without `--yes` has to exit non-zero and
 * say nothing was sent, and no renderer test can show that the process agrees.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  ENTRY_COLUMNS,
  formatRemaining,
  formatTokens,
  renderCostView,
  renderCoverage,
  renderEntries,
  renderStats,
} from "../../continuity/cli/cost.js";
import { STATUS_COLUMNS, USAGE_LINES, renderRun, renderStatus } from "../../continuity/cli/measure.js";
import { CACHE_CONFIDENCE, CACHE_EVIDENCE } from "../../continuity/cache/confidence.js";
import { createCacheEntry } from "../../continuity/cache/entry.js";
import { observeCacheResult } from "../../continuity/cache/observer.js";
import { DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { BLOCKED_REASON, RUN_STATUS, buildExperimentRow, measureStatus, runMeasure } from "../../continuity/evidence/index.js";
import { TOKEN_PROVENANCE } from "../../continuity/prefix/tokens.js";

import { SYSTEM, makeTmpDir, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const NOW = 1_700_000_000_000;

const VENDOR_YAML = [
  "provider: vendor",
  "mechanism: explicit",
  "breakpoints: 4",
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

const REGISTRY = loadCacheModels({
  source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }),
  now: NOW,
  policy: DEFAULT_CACHE_POLICY,
});

const clockAt = (now) => ({ now: () => now });

describe("E — `cost` renders a belief without ever totalling it", () => {
  let h;

  beforeEach(async () => {
    h = await openHarness({ tag: "m2-cli" });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  async function observe({ usage, provider = "vendor", pricingKey = "vendor", msgs = messages(100, "cli ") } = {}) {
    const observation = await h.observe(turnRequest({ msgs }));
    return observeCacheResult({
      store: h.store,
      clock: h.clock,
      registry: REGISTRY,
      observation,
      result: { provider, pricing_key: pricingKey, model: "vendor-model", status: "ok", http_status: 200, usage, at: h.at() },
    });
  }

  const view = (options = {}, now = h.at()) =>
    renderCostView({ store: h.store, registry: REGISTRY, clock: clockAt(now), options }).text;

  /** One section of the rendered view, by its heading. Both tables have a `vendor` row. */
  const section = (text, heading) => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l === `## ${heading}`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("## "));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  };

  it("says so plainly when there is nothing recorded yet", () => {
    const text = view();
    expect(text).toContain("no cache entries recorded");
    expect(text).toContain("no provider results recorded");
    // The pricing version is printed even with an empty database: an operator reading
    // "nothing here" needs to know which pricing produced the nothing.
    expect(text).toMatch(/pricing version: cm1:\d+:[0-9a-f]{16} \(\d+ ok, \d+ stale, \d+ disabled\)/);
  });

  it("keeps assumed and confirmed in separate rows, and never prints their sum", async () => {
    await observe({ usage: { input: 4000, cache_read: 1500 } });
    h.tick(1000);
    await observe({ usage: { input: 4000 }, msgs: messages(140, "other ") });

    const text = view();
    expect(text).toContain("## cache belief");
    expect(text).toMatch(/PROVIDER\s+CONFIDENCE\s+ENTRIES\s+TOKENS/);
    const confidences = section(text, "cache belief")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("vendor"))
      .map((l) => l.split(/\s+/)[1]);
    // Both beliefs are present and reported apart. A single "vendor" row would mean
    // somebody had added them.
    expect(new Set(confidences)).toEqual(new Set([CACHE_CONFIDENCE.CONFIRMED, CACHE_CONFIDENCE.ASSUMED]));
    expect(text).toContain("assumed and confirmed are reported separately on purpose; they are not addable (I3).");
  });

  it("counts the silent-but-assumed population in the coverage table", async () => {
    await observe({ usage: { input: 4000, cache_read: 1500 } });
    h.tick(1000);
    await observe({ usage: { input: 4000 } });

    const text = view();
    expect(text).toContain("## provider cache reporting");
    expect(text).toMatch(/PROVIDER\s+RESULTS\s+REPORTED\s+SILENT\s+CONFIRMED\s+ASSUMED\s+UNKNOWN\s+SILENT\+ASSUMED/);
    const row = section(text, "provider cache reporting")
      .split(/\r?\n/)
      .find((l) => l.startsWith("vendor"));
    const [, total, reported, silent] = row.split(/\s+/);
    expect([total, reported, silent]).toEqual(["2", "1", "1"]);
  });

  it("shows the stored confidence beside the one that applies now", async () => {
    await observe({ usage: { input: 4000, cache_read: 1500 } });
    // Past the half-life of a 300s TTL: §4.2 degrades what a caller may act on, and both
    // values are shown because "why is this only assumed?" is the question an operator
    // brings to this table.
    const text = view({ provider: "vendor", model: "vendor-model" }, h.at() + 200_000);
    for (const column of ENTRY_COLUMNS) expect(text).toContain(column);
    const line = text.split(/\r?\n/).find((l) => l.includes(" tools "));
    expect(line).toContain(CACHE_CONFIDENCE.CONFIRMED);
    expect(line).toContain(CACHE_CONFIDENCE.ASSUMED);
    expect(line).toContain(CACHE_EVIDENCE.PROVIDER_REPORTED_READ);
    expect(line).toMatch(/1m$|\d+s$/);
  });

  it("prints a dash, not a zero, for a route that can claim nothing (I4)", () => {
    const entry = createCacheEntry({
      provider: "a-provider-nobody-documented",
      model: "m",
      prefix_hash: "c1:" + "0".repeat(64),
      layer: "tools",
      tokens: 4000,
      written_at: NOW,
      ttl_s: 0,
      tokens_provenance: TOKEN_PROVENANCE.ESTIMATED,
    });
    const text = renderEntries([entry], { now: NOW, registry: REGISTRY });
    // 4000 tokens were sent, but with no cache model there is no cached-token claim to
    // make about them, and `0` would be a measurement nobody took.
    expect(text).not.toContain("4000");
    expect(text).toContain("-");
    expect(text).toContain("expired");
    expect(formatTokens(4000, false)).toBe("-");
    expect(formatTokens(4000, true)).toBe("4000");
    expect(formatRemaining(0)).toBe("expired");
    expect(formatRemaining(-1)).toBe("expired");
    expect(formatRemaining(90_000)).toBe("1m");
    expect(formatRemaining(7_400_000)).toBe("2h3m");
  });

  it("renders the pricing table on --pricing and nothing else", async () => {
    await observe({ usage: { input: 4000, cache_read: 1500 } });
    const text = view({ pricing: true });
    expect(text).toContain("## cache pricing");
    expect(text).toMatch(/vendor\s+ok\s+explicit/);
    expect(text).toMatch(/pricing version: cm1:/);
    // A pricing question gets a pricing answer: mixing the belief table in would invite
    // reading one provider's status as the other's evidence.
    expect(text).not.toContain("## cache belief");
  });

  it("names the provider whose cache model failed, at the level it failed at", () => {
    const registry = loadCacheModels({ source: createMemorySource({ default: DEFAULT_YAML, vendor: "broken: [" }), now: NOW });
    const text = renderCostView({ store: h.store, registry, clock: clockAt(NOW), options: { pricing: true } }).text;
    expect(text).toContain("### pricing diagnostics");
    expect(text).toMatch(/- \[error\] vendor:/);
    expect(text).toMatch(/vendor\s+disabled:malformed\s+none/);
  });

  it("emits parseable JSON that carries the state but not the request (§14)", async () => {
    const needle = "PLEASE-DO-NOT-PERSIST-ME";
    await observe({ usage: { input: 4000, cache_read: 1500 }, msgs: [{ role: "user", content: needle }, ...messages(100, "cli ")] });

    const raw = renderCostView({
      store: h.store,
      registry: REGISTRY,
      clock: clockAt(h.at()),
      options: { json: true, provider: "vendor", model: "vendor-model" },
    }).text;
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({ now: h.at(), pricing_version: REGISTRY.version });
    expect(payload.entries.length).toBeGreaterThan(0);
    // The recomputed state travels with the row, so a machine reader gets the same
    // effective confidence a human sees rather than re-deriving the half-life rule.
    expect(payload.entries[0].state).toMatchObject({ expired: false, stored_confidence: CACHE_CONFIDENCE.CONFIRMED });
    expect(payload.coverage[0].provider).toBe("vendor");
    for (const forbidden of [needle, SYSTEM, "cli ", "read_file"]) expect(raw).not.toContain(forbidden);
  });

  it("has an empty state for each table, so no section renders as a blank", () => {
    expect(renderEntries([], {})).toBe("no cache entries recorded");
    expect(renderStats(null)).toBe("no cache entries recorded");
    expect(renderCoverage([])).toBe("no provider results recorded");
  });
});

describe("E — `measure --status` reads as ungraded until a person grades it", () => {
  let h;

  beforeEach(async () => {
    h = await openHarness({ tag: "m2-cli-measure" });
  });
  afterEach(() => {
    const dir = h.dir;
    h.close();
    removeTmpDir(dir);
  });

  it("lists every question with no run as missing, and says what blocks M3", () => {
    const text = renderStatus(measureStatus({ store: h.store }));
    for (const column of STATUS_COLUMNS) expect(text).toContain(column);
    // The verdict column comes before the number, so no reader meets a figure before
    // meeting its grade.
    expect(text.indexOf("VERDICT")).toBeLessThan(text.indexOf("ERROR BAND"));
    expect(text).toContain("M3 gate (Q1, Q2, Q3): BLOCKED");
    for (const q of ["Q1", "Q2", "Q3"]) expect(text).toContain(`- ${q}: no run recorded`);
    expect(text).toContain("0 recorded run(s). A run does not unblock anything by existing.");
    // A question no measure here can answer says so, rather than looking unanswered.
    expect(text).toContain("(no measure)");
  });

  it("shows a recorded run as awaiting review, with the reviewer absent", async () => {
    const run = await runMeasure({ store: h.store, clock: h.clock, measure: "coverage", args: { store: h.store } });
    expect(run.row.verdict).toBe("pending");

    const text = renderStatus(measureStatus({ store: h.store }));
    expect(text).toContain("- Q1: run recorded, awaiting human review");
    const line = text.split(/\r?\n/).find((l) => l.startsWith("Q1"));
    // `-` in the reviewer column: the run exists and nobody stands behind it yet.
    expect(line).toMatch(/^Q1\s+pending\s+-\s/);
    expect(text).toContain("1 recorded run(s).");

    h.store.experiments.setVerdict(h.db, run.row.id, { verdict: "insufficient", reviewed_by: "a named human", reviewed_at: h.at() });
    const graded = renderStatus(measureStatus({ store: h.store }));
    expect(graded).toContain("- Q1: reviewed and judged insufficient");
    expect(graded).toMatch(/^Q1\s+insufficient\s+a named human/m);
  });

  it("renders a blocked run as unavailable, and prices the run that would unblock it", () => {
    const result = {
      measure: "cache_probe",
      question: "Q1",
      status: RUN_STATUS.BLOCKED,
      blocked_reason: BLOCKED_REASON.NOT_OPTED_IN,
      n: 0,
      plan: { requests: 2, approx_input_tokens: 4096, real_money: true },
      notes: ["nothing was sent"],
    };
    const row = buildExperimentRow({ measure: "cache_probe", result, ran_at: NOW });
    const text = renderRun({ row, result, markdown: "# a report nobody saved" });
    expect(text).toContain("This measurement is UNAVAILABLE, not zero. Reason: not_opted_in.");
    // The number an operator needs before agreeing to spend: requests, tokens, and whose
    // account pays.
    expect(text).toContain("Running it would send 2 request(s) (~4096 input tokens) on your credentials and bill your account.");
    expect(text).toContain("verdict:     pending — set it yourself; the harness never grades its own run");
    expect(text).toContain("note: nothing was sent");
    expect(text).toContain("report:      not written (no report directory supplied)");
  });

  it("warns in its own usage text that a live measure spends money", () => {
    const usage = USAGE_LINES.join("\n");
    expect(usage).toContain("cache_probe");
    expect(usage).toMatch(/send real requests and cost real money; they need --yes/);
  });
});

/**
 * The script as an operator runs it: a separate `node`, no bundler, a data root from the
 * environment. Exit codes are part of the contract here — a closed M3 gate is a non-zero
 * status so a script cannot mistake "not yet evidenced" for "evidenced".
 */
describe("§13 `cost` and `measure` as a process", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..");
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) removeTmpDir(dir);
  });

  function run(args, dataDir) {
    const out = spawnSync(process.execPath, [path.join(ROOT, "scripts", "dxrouter.mjs"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DXR_DATA_DIR: dataDir },
      // spawnSync blocks the worker, so vitest's testTimeout cannot interrupt a hung
      // child; this bound is the only one. A spawn failure or a kill must surface as
      // itself, not as `expected null to be 0` on the status assertion.
      timeout: 30_000,
    });
    if (out.error) throw new Error(`dxrouter ${args.join(" ")}: ${out.error.message}\n${out.stderr ?? ""}`);
    if (out.signal) throw new Error(`dxrouter ${args.join(" ")}: killed by ${out.signal}\n${out.stderr ?? ""}`);
    return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  }

  const tmp = () => {
    const dir = makeTmpDir("cliproc-m2");
    dirs.push(dir);
    return dir;
  };

  it("prints the cost view as JSON on stdout, under bare node", () => {
    const dir = tmp();
    const out = run(["cost", "--json"], dir);
    expect(out.status).toBe(0);
    const payload = JSON.parse(out.stdout);
    expect(payload).toMatchObject({ entries: [], stats: [], coverage: [] });
    expect(payload.pricing_version).toMatch(/^cm1:/);
    // The shipped records, loaded by the same code the server uses.
    expect(payload.pricing.length).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(dir, "db", "continuity.sqlite"))).toBe(true);
  });

  it("loads the shipped pricing records and reports their status", () => {
    const out = run(["cost", "--pricing"], tmp());
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/PROVIDER\s+STATUS\s+MECHANISM\s+VERIFIED\s+DETAIL/);
    // `ok` or `stale`, never disabled, and the mechanism survives either way. The two
    // records that claim cache economics were verified against documentation on
    // 2026-05-01, so on a checkout more than 90 days later they read `stale` and their
    // terms are labelled estimated — §9.3's graceful path, and the property worth pinning
    // is that staleness downgrades a record rather than disabling it. Pinning `ok` here
    // would make this test a clock.
    expect(out.stdout).toMatch(/anthropic\s+(ok|stale)\s+explicit/);
    expect(out.stdout).toMatch(/openai\s+(ok|stale)\s+implicit/);
    expect(out.stdout).not.toMatch(/disabled:(malformed|unverified)/);
    expect(out.stdout).toMatch(/providers: \d+ ok, \d+ stale, 0 disabled/);
  });

  it("exits non-zero while the M3 gate is closed", () => {
    const out = run(["measure", "--status"], tmp());
    // Not an error — a status. But a closed gate must not look like success to CI.
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("M3 gate (Q1, Q2, Q3): BLOCKED");
    expect(out.stdout).toContain("a verdict is set by a person, not by a run");
  });

  it("refuses to send anything for cache_probe without --yes", () => {
    const out = run(["measure", "cache_probe"], tmp());
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("sends real provider requests and costs real money");
    expect(out.stderr).toContain("Nothing was sent.");
    // And no run was recorded, so a refusal cannot later be read as a measurement.
    expect(run(["measure", "--status"], dirs[dirs.length - 1]).stdout).toContain("0 recorded run(s)");
  });

  it("reports blocked rather than erroring when it cannot build an executor at all", () => {
    const out = run(["measure", "cache_probe", "--yes"], tmp());
    // Bare node cannot resolve the `open-sse` alias, so this host has no RouteExecutor.
    // The measure says so and still records the attempt.
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("status:      blocked (no_executor)");
    expect(out.stdout).toContain("This measurement is UNAVAILABLE, not zero.");
  });

  it("records a real run, writes its report, and refuses to grade it", () => {
    const dir = tmp();
    const out = run(["measure", "coverage"], dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/coverage -> Q1   run exp_[0-9a-f]{16}/);
    expect(out.stdout).toMatch(/recorded as exp_[0-9a-f]{16} with verdict "pending" — a person grades it\./);

    const reports = fs.readdirSync(path.join(dir, "evidence"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^Q1-coverage-\d{4}-\d{2}-\d{2}\.md$/);
    const markdown = fs.readFileSync(path.join(dir, "evidence", reports[0]), "utf8");
    expect(markdown).toContain("## How far to trust this");
    // The repository ships only synthetic fixtures, and the report has to say so before
    // anyone reads a percentage off it.
    expect(markdown).toMatch(/synthetic/i);

    // The run is on record and the gate is still shut.
    const status = run(["measure", "--status"], dir);
    expect(status.status).toBe(1);
    expect(status.stdout).toContain("1 recorded run(s).");
    expect(status.stdout).toContain("- Q1: run recorded, awaiting human review");
  });

  it("rejects a measure it does not have without touching the database", () => {
    const out = run(["measure", "vibes"], tmp());
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("unknown measure: vibes");
    expect(out.stderr).toMatch(/expected one of: .*coverage/);
  });
});
