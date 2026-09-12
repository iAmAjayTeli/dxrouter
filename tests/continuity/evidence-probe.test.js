/**
 * I-7 — `cache_probe`, executable and safe, without sending one byte.
 *
 * `cache_probe` is the only §19.4 measure that spends money, and until the probe executor
 * existed the CLI could not build one at all: the measure reported `no_executor` forever,
 * which made the §23 gate name a measurement nobody could take. That makes two things worth
 * testing, and this file is split along them:
 *
 *  - **It can run.** The ladder helpers (`parseLadder`, `selectRungs`, `planProbe`,
 *    `summarizeLadder`, `probeUsage`) and `createProbeExecutor` are exercised directly, the
 *    latter with an injected `fetchImpl`. **No test here touches the network** — every
 *    request either goes to a recorder or is refused before a request could exist.
 *  - **It cannot run by accident.** Each of the five refusals is asserted *together with*
 *    the executor having been called zero times, because "blocked" is only meaningful if
 *    nothing was sent on the way to saying it.
 *
 * The measurement rules under test are the same two that govern the rest of M2. A rung
 * whose reads were silent is `unknown`, never `miss` — folding silence into expiry would
 * turn "the provider said nothing" into "the cache had expired" (I4). And the answer is an
 * *interval* between the last rung that hit and the first that missed, never a point: the
 * ladder never observed the boundary, only that it lies between two rungs (§10.4).
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_LADDER_MS,
  PROBE_ARMS,
  ladderLabel,
  measureCacheProbe,
  parseLadder,
  planProbe,
  probeFiller,
  probeUsage,
  selectRungs,
  summarizeLadder,
} from "../../continuity/evidence/measures/cacheProbe.js";
import { BLOCKED_REASON, RUN_STATUS } from "../../continuity/evidence/harness.js";
import { assertSafeBaseUrl, buildProbeBody, createProbeExecutor } from "../../adapters/ninerouter/probeExecutor.js";
import { createMemorySource, loadCacheModels } from "../../continuity/cache/pricing/index.js";
import { DEFAULT_CACHE_POLICY } from "../../continuity/cache/policy.js";

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

const registry = () =>
  loadCacheModels({ source: createMemorySource({ default: DEFAULT_YAML, vendor: VENDOR_YAML }), now: NOW, policy: DEFAULT_CACHE_POLICY });

const clock = { now: () => NOW };
const ROUTE = { provider: "vendor-alias", model: "vendor-model" };

/** A recorder in the shape of a `RouteExecutor`. Nothing leaves the process. */
function recorder(usageByCall = []) {
  const calls = [];
  return {
    calls,
    executor: {
      async execute(route, req) {
        calls.push({ route, req });
        const usage = usageByCall[calls.length - 1] ?? null;
        return { status: 200, ok: true, error_class: null, usage, reported_model: route.model };
      },
    },
  };
}

describe("A — the ladder is parsed, labelled and priced before anything is sent", () => {
  it("parses the units an operator actually types, and sorts and dedupes", () => {
    expect(parseLadder("30s,2m,5.5m,65m")).toEqual([30_000, 120_000, 330_000, 3_900_000]);
    expect(parseLadder("2m,30s")).toEqual([30_000, 120_000]);
    expect(parseLadder("2m,120000,2m")).toEqual([120_000]);
    expect(parseLadder("1h")).toEqual([3_600_000]);
    // A bare number is milliseconds, so `5000` is five seconds and not five thousand of
    // something an operator would have to guess at.
    expect(parseLadder("5000")).toEqual([5000]);
    expect(parseLadder([30_000, "1m"])).toEqual([30_000, 60_000]);
  });

  it("returns null rather than an empty ladder, and drops what it cannot read", () => {
    for (const bad of [null, undefined, "", "abc", "-5s", "0", "0s"]) expect(parseLadder(bad)).toBe(null);
    expect(parseLadder("-5s,0,3s")).toEqual([3000]);
  });

  it("labels a rung in the coarsest unit that is exact", () => {
    expect(ladderLabel(3_600_000)).toBe("1h");
    expect(ladderLabel(3_900_000)).toBe("65m");
    expect(ladderLabel(120_000)).toBe("2m");
    expect(ladderLabel(330_000)).toBe("330s");
    expect(ladderLabel(1500)).toBe("1500ms");
  });

  it("`arms` spends requests on one side of a believed TTL only", () => {
    const ladder = [30_000, 120_000, 600_000, 3_900_000];
    expect(selectRungs(ladder, { arms: PROBE_ARMS.BELOW, ttlS: 300 })).toEqual([30_000, 120_000]);
    expect(selectRungs(ladder, { arms: PROBE_ARMS.ABOVE, ttlS: 300 })).toEqual([600_000, 3_900_000]);
    expect(selectRungs(ladder, { arms: PROBE_ARMS.BOTH, ttlS: 300 })).toEqual(ladder);
    // Nothing to split on: an unverified route runs the whole ladder rather than half of a
    // window nobody has measured.
    expect(selectRungs(ladder, { arms: PROBE_ARMS.ABOVE, ttlS: null })).toEqual(ladder);
    expect(DEFAULT_LADDER_MS.length).toBeGreaterThan(2);
  });

  it("states requests, tokens AND wall-clock before a run", () => {
    const plan = planProbe({ pricingKey: "vendor", model: "m", minTokens: 2048, repetitions: 2, ladderMs: [30_000, 120_000] });
    // Two calls per rung — the write, and the read that tests it.
    expect(plan.requests).toBe(8);
    expect(plan.approx_input_tokens).toBe(8 * 2048);
    // The hour a long ladder spends waiting is the cost an operator kills the process over.
    expect(plan.approx_wall_clock_ms).toBe(2 * 150_000);
    expect(plan.ladder).toEqual(["30s", "2m"]);
    expect(plan.real_money).toBe(true);

    const single = planProbe({ pricingKey: "vendor", model: "m", gapMs: 5000, ladderMs: null });
    expect(single.requests).toBe(2);
    expect(single.ladder_ms).toEqual([5000]);
  });

  it("the probe prefix is filler of a known length, never user material", () => {
    const filler = probeFiller(64);
    expect(filler).toHaveLength(256);
    expect(filler).toBe(probeFiller(64));
    expect(filler.startsWith("The quick brown fox")).toBe(true);
  });
});

describe("B — `probeUsage` reads both spellings and never invents a zero", () => {
  it("accepts the engine's shape and the adapter's `*_tokens` shape alike", () => {
    expect(probeUsage({ input: 10, output: 2, cache_read: 8, cache_write: 4 })).toMatchObject({ input: 10, cache_read: 8, cache_write: 4 });
    // Reading only one spelling made a real executor look like a silent provider, which
    // would have been reported as "this route cannot produce cache evidence".
    expect(probeUsage({ input_tokens: 10, cache_read_tokens: 8, cache_write_tokens: 4 })).toMatchObject({ input: 10, cache_read: 8, cache_write: 4 });
    expect(probeUsage({ prompt_tokens: 10, cache_read_input_tokens: 8, cache_creation_input_tokens: 4 })).toMatchObject({
      input: 10,
      cache_read: 8,
      cache_write: 4,
    });
  });

  it("absent stays null, a reported zero stays zero, and an estimate stays labelled", () => {
    expect(probeUsage({ input_tokens: 10 })).toEqual({ input: 10, output: null, cache_read: null, cache_write: null, estimated: false });
    expect(probeUsage({ cache_read_tokens: 0 }).cache_read).toBe(0);
    expect(probeUsage(null)).toEqual({ input: null, output: null, cache_read: null, cache_write: null, estimated: false });
    expect(probeUsage({ input_tokens: 10, estimated: true }).estimated).toBe(true);
  });
});

describe("C — a rung's verdict, and the interval the boundary lies in", () => {
  const read = (gapMs, extra) => ({ phase: "read", gap_ms: gapMs, usage_in: 2048, ...extra });

  it("hit, miss and unknown are three outcomes, not two", () => {
    const out = summarizeLadder([
      { phase: "write", gap_ms: 30_000, cache_read: null, provider_reported: false },
      read(30_000, { cache_read: 2048, provider_reported: true }),
      read(120_000, { cache_read: 0, provider_reported: true }),
      // Silent: the provider said nothing. Counting this as a miss would turn silence into
      // a measured expiry (I4).
      read(600_000, { cache_read: null, provider_reported: false }),
    ]);
    expect(out.rungs.map((r) => [r.gap, r.verdict])).toEqual([["30s", "hit"], ["2m", "miss"], ["10m", "unknown"]]);
    expect(out.rungs[0].reported_read_tokens).toBe(2048);
    // Write rows are not evidence about a window; only the read that tested it is.
    expect(out.rungs).toHaveLength(3);
  });

  it("reports an interval between the two rungs, never a point estimate", () => {
    const out = summarizeLadder([
      read(30_000, { cache_read: 8, provider_reported: true }),
      read(120_000, { cache_read: 0, provider_reported: true }),
    ]);
    expect(out.ttl_interval_s).toMatchObject({ last_hit_s: 30, first_miss_s: 120, band: "30s..120s" });
  });

  it("says which end is missing when the ladder never crossed the boundary", () => {
    const allHit = summarizeLadder([read(30_000, { cache_read: 8, provider_reported: true })]);
    expect(allHit.ttl_interval_s.band).toBe(">= 30s (no rung missed; the ladder did not reach expiry)");
    const allMiss = summarizeLadder([read(600_000, { cache_read: 0, provider_reported: true })]);
    expect(allMiss.ttl_interval_s.band).toBe("< 600s");
    const silent = summarizeLadder([read(30_000, { cache_read: null, provider_reported: false })]);
    expect(silent.ttl_interval_s.band).toMatch(/^unavailable: no rung produced/);
  });
});

describe("D — five refusals, each with nothing sent", () => {
  const base = () => ({ clock, registry: registry(), pricingKey: "vendor", route: ROUTE, ladder: "30s,2m", sleep: async () => {} });

  it("without `optIn: true` it prices the run and sends nothing", async () => {
    const { calls, executor } = recorder();
    const out = await measureCacheProbe({ ...base(), executor });
    expect(out.status).toBe(RUN_STATUS.BLOCKED);
    expect(out.blocked_reason).toBe(BLOCKED_REASON.NOT_OPTED_IN);
    // The cost of the run it refused to make, so a host can print it and stop.
    expect(out.plan.requests).toBe(4);
    expect(out.n).toBe(0);
    expect(out.probes).toEqual([]);
    expect(calls).toHaveLength(0);
    // `optIn` is a boolean the host owns; nothing truthy short of `true` counts.
    for (const nearly of [1, "true", "yes", {}]) {
      expect((await measureCacheProbe({ ...base(), executor, optIn: nearly })).blocked_reason).toBe(BLOCKED_REASON.NOT_OPTED_IN);
    }
    expect(calls).toHaveLength(0);
  });

  it("without an executor the engine says so rather than reaching for a client of its own", async () => {
    const out = await measureCacheProbe({ ...base(), optIn: true, executor: null });
    expect(out.blocked_reason).toBe(BLOCKED_REASON.NO_EXECUTOR);
    expect(out.notes.join(" ")).toMatch(/the engine cannot reach a provider itself/);
    expect((await measureCacheProbe({ ...base(), optIn: true, executor: { execute: "not a function" } })).blocked_reason).toBe(
      BLOCKED_REASON.NO_EXECUTOR,
    );
  });

  it("a route must name both a provider and a model", async () => {
    const { calls, executor } = recorder();
    for (const route of [null, { provider: "vendor-alias" }, { model: "vendor-model" }]) {
      const out = await measureCacheProbe({ ...base(), optIn: true, executor, route });
      expect(out.blocked_reason).toBe(BLOCKED_REASON.NO_EXECUTOR);
      expect(out.notes).toContain("route must name a provider and a model");
    }
    expect(calls).toHaveLength(0);
  });

  it("a Clock port is required; the engine reads no wall clock of its own", async () => {
    const { calls, executor } = recorder();
    const out = await measureCacheProbe({ ...base(), optIn: true, executor, clock: null });
    expect(out.blocked_reason).toBe(BLOCKED_REASON.NO_EXECUTOR);
    expect(out.notes.join(" ")).toMatch(/Clock port is required/);
    expect(calls).toHaveLength(0);
  });

  it("an arm that selects no rung is refused instead of quietly sending nothing", async () => {
    const { calls, executor } = recorder();
    // Every rung is below the vendor's verified 300 s window, so `above` is empty.
    const out = await measureCacheProbe({ ...base(), optIn: true, executor, arms: PROBE_ARMS.ABOVE });
    expect(out.blocked_reason).toBe(BLOCKED_REASON.NO_EXECUTOR);
    expect(out.notes.join(" ")).toMatch(/the above arm of this ladder is empty; nothing would be sent/);
    expect(out.plan.rungs).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("E — an opted-in run, against a recorder rather than a provider", () => {
  it("walks the ladder, waits the rung, and brackets the window it observed", async () => {
    const { calls, executor } = recorder([
      { input_tokens: 2048, cache_write_tokens: 2048 },
      { input_tokens: 2048, cache_read_tokens: 2048 },
      { input_tokens: 2048, cache_write_tokens: 2048 },
      // A reported zero at the longer gap: the provider looked and found nothing cached.
      { input_tokens: 2048, cache_read_tokens: 0 },
    ]);
    const waits = [];
    const out = await measureCacheProbe({
      optIn: true,
      executor,
      clock,
      registry: registry(),
      pricingKey: "vendor",
      route: ROUTE,
      ladder: "30s,2m",
      minTokens: 64,
      sleep: async (ms) => waits.push(ms),
    });

    expect(out.status).toBe(RUN_STATUS.OK);
    expect(calls).toHaveLength(4);
    // The wait belongs to the write, and it is the rung being tested.
    expect(waits).toEqual([30_000, 120_000]);
    expect(out.n).toBe(4);
    expect(out.reads_attempted).toBe(2);
    expect(out.reads_reported).toBe(1);
    expect(out.silent_reads).toBe(0);
    expect(out.failures).toBe(0);
    expect(out.ladder.map((r) => [r.gap, r.verdict])).toEqual([["30s", "hit"], ["2m", "miss"]]);
    expect(out.ttl_interval_s.band).toBe("30s..120s");
    expect(out.notes.join(" ")).toMatch(/measured TTL is an interval, not a point/);
    // The documented window is what the ladder was chosen around, never a verdict.
    expect(out.documented_ttl_s).toBe(300);
    expect(out.mechanism).toBe("explicit");
  });

  it("the prefix is byte-identical filler in both phases, and carries no user material", async () => {
    const { calls, executor } = recorder();
    await measureCacheProbe({
      optIn: true, executor, clock, registry: registry(), pricingKey: "vendor", route: ROUTE,
      minTokens: 64, gapMs: 1, sleep: async () => {},
    });
    expect(calls).toHaveLength(2);
    const [write, read] = calls;
    // A byte-identical prefix is the whole experiment: if the two differed, a miss would
    // measure our own request instead of the provider's window.
    expect(read.req.system).toBe(write.req.system);
    expect(read.req.system).toBe(probeFiller(64));
    expect(read.req.messages).toEqual([{ role: "user", content: "Reply with the single word: ok" }]);
    expect(read.req.params).toMatchObject({ stream: false });
    expect(read.req.client_hint).toEqual({ source: "dxrouter-cache-probe" });
  });
});

describe("F — silence, estimates and failures are recorded, never converted", () => {
  const run = (usageByCall, extra = {}) =>
    measureCacheProbe({
      optIn: true, clock, registry: registry(), pricingKey: "vendor", route: ROUTE,
      ladder: "30s", sleep: async () => {}, ...recorder(usageByCall), ...extra,
    });

  it("silence across every read is reported as such, not as an expired window", async () => {
    const out = await run([null, null]);
    expect(out.reads_reported).toBe(0);
    expect(out.silent_reads).toBe(1);
    expect(out.ladder[0].verdict).toBe("unknown");
    expect(out.ttl_interval_s.last_hit_s).toBe(null);
    expect(out.ttl_interval_s.first_miss_s).toBe(null);
    expect(out.notes.join(" ")).toMatch(/this route cannot produce confirmed cache evidence today/);
  });

  it("a 9Router estimate is recorded as an estimate and not counted as cache evidence", async () => {
    const out = await run([{ input_tokens: 300, estimated: true }, { input_tokens: 300, estimated: true }]);
    expect(out.probes.every((p) => p.usage_estimated)).toBe(true);
    expect(out.reads_reported).toBe(0);
    expect(out.notes.join(" ")).toMatch(/an estimate is not cache evidence/);
  });

  it("an unverified route still probes, and the reported side stays unreconciled", async () => {
    const out = await run([{ input_tokens: 10 }, { input_tokens: 10, cache_read_tokens: 5 }], { pricingKey: "default" });
    expect(out.mechanism).toBe("none");
    expect(out.documented_ttl_s).toBe(null);
    // A reported read against a `mechanism: none` record is the evidence for adding one —
    // it is never backfilled into the registry from here.
    expect(out.notes.join(" ")).toMatch(/no verified cache model; a reported read here would be the evidence to add one/);
    expect(out.billed_vs_reported).toMatchObject({ status: "unreconciled", reported_read_tokens: 5, billed_read_tokens: null });
  });

  it("an executor that throws is recorded as a failed attempt, not an aborted ladder", async () => {
    const out = await measureCacheProbe({
      optIn: true, clock, registry: registry(), pricingKey: "vendor", route: ROUTE, ladder: "30s", sleep: async () => {},
      executor: {
        async execute() {
          throw new Error("connect ECONNREFUSED 127.0.0.1:1");
        },
      },
    });
    expect(out.status).toBe(RUN_STATUS.OK);
    expect(out.failures).toBe(2);
    expect(out.probes[0].failure).toMatch(/ECONNREFUSED/);
    expect(out.probes[0].cache_read).toBe(null);
    expect(out.ladder[0].verdict).toBe("unknown");
  });
});

describe("G — `createProbeExecutor` refuses before it can spend anything", () => {
  const KEY_ENV = { DXR_TEST_PROBE_KEY: "sk-test-not-a-real-key" };

  it("needs an endpoint and the NAME of a key variable, and reads no stored credential", () => {
    expect(createProbeExecutor({ env: {} })).toMatchObject({ executor: null, endpoint: null });
    expect(createProbeExecutor({ env: {} }).reason).toMatch(/no base URL/);
    expect(createProbeExecutor({ baseUrl: "https://api.example.invalid/v1", env: {} }).reason).toMatch(/no API key env var named/);
    // Named but unset: refused rather than sent with an empty Authorization header.
    expect(createProbeExecutor({ baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "NOT_SET_HERE", env: {} }).reason).toMatch(
      /NOT_SET_HERE is not set in this environment/,
    );
  });

  it("refuses an unknown protocol and a non-TLS endpoint that is not loopback", () => {
    expect(
      createProbeExecutor({ baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", protocol: "grpc", env: KEY_ENV }).reason,
    ).toMatch(/unknown probe protocol/);
    expect(createProbeExecutor({ baseUrl: "http://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: KEY_ENV }).reason).toMatch(
      /must be https/,
    );
    expect(assertSafeBaseUrl("http://127.0.0.1:20128/v1").hostname).toBe("127.0.0.1");
    expect(assertSafeBaseUrl("https://api.anthropic.com/v1").protocol).toBe("https:");
    expect(() => assertSafeBaseUrl("http://example.invalid/v1")).toThrow(/must be https/);
  });

  it("no refusal reason ever contains the key itself", () => {
    const reasons = [
      createProbeExecutor({ env: {} }).reason,
      createProbeExecutor({ baseUrl: "http://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: KEY_ENV }).reason,
      createProbeExecutor({ baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "MISSING", env: KEY_ENV }).reason,
    ];
    for (const reason of reasons) expect(reason).not.toContain(KEY_ENV.DXR_TEST_PROBE_KEY);
  });

  it("builds the documented endpoint for each protocol, and only that", () => {
    const openai = createProbeExecutor({
      baseUrl: "https://api.example.invalid/v1/", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: KEY_ENV, fetchImpl: async () => {},
    });
    expect(openai.endpoint).toBe("https://api.example.invalid/v1/chat/completions");
    const anthropic = createProbeExecutor({
      baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", protocol: "anthropic", env: KEY_ENV, fetchImpl: async () => {},
    });
    expect(anthropic.endpoint).toBe("https://api.anthropic.com/v1/messages");
  });

  it("the anthropic body carries the explicit breakpoint the mechanism under test needs", () => {
    const body = buildProbeBody({ protocol: "anthropic", model: "m", system: "filler", messages: [{ role: "user", content: "ok" }] });
    // Without the breakpoint this provider caches nothing, and the probe would measure the
    // absence of our own marker and report it as the provider not caching.
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.stream).toBe(false);
    const openai = buildProbeBody({ protocol: "openai", model: "m", system: "filler", messages: [{ role: "user", content: "ok" }] });
    expect(openai.messages[0]).toEqual({ role: "system", content: "filler" });
  });
});

describe("H — one executed probe request, through an injected fetch", () => {
  const ENV = { DXR_TEST_PROBE_KEY: "sk-test-not-a-real-key" };
  const req = { system: "filler", messages: [{ role: "user", content: "ok" }], params: { max_tokens: 16 } };

  it("normalizes a provider's own cache fields through the same field table the observer uses", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, init });
      return {
        status: 200,
        async json() {
          return {
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 2048, output_tokens: 3, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0 },
          };
        },
      };
    };
    const { executor, endpoint } = createProbeExecutor({
      baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", protocol: "anthropic", env: ENV, fetchImpl,
    });
    const out = await executor.execute({ provider: "claude", model: "claude-sonnet-4-20250514" }, req);

    expect(seen[0].url).toBe(endpoint);
    expect(seen[0].init.headers["x-api-key"]).toBe(ENV.DXR_TEST_PROBE_KEY);
    expect(seen[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(seen[0].init.body).system[0].text).toBe("filler");
    expect(out.status).toBe(200);
    expect(out.reported_model).toBe("claude-sonnet-4-20250514");
    // The probe and a live request agree about what the provider reported, because both go
    // through `normalizeUsage`. A reported 0 write stays 0; nothing absent becomes a zero.
    expect(probeUsage(out.usage)).toMatchObject({ input: 2048, cache_read: 2048, cache_write: 0, estimated: false });
  });

  it("an HTTP failure is classified and carries no usage at all", async () => {
    const fetchImpl = async () => ({ status: 429, async json() { return { error: { message: "slow down" } }; } });
    const { executor } = createProbeExecutor({
      baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: ENV, fetchImpl,
    });
    const out = await executor.execute(ROUTE, req);
    expect(out).toMatchObject({ status: 429, ok: false, error_class: "rate_limit", usage: null });
    // Nothing is retried and no backoff is attempted here: a probe that hammered a
    // rate-limited endpoint would be an anti-abuse problem, not a measurement.
    expect(out.error_message).toBe("HTTP 429");
  });

  it("a transport failure is a result, so a paid ladder is not abandoned mid-run", async () => {
    const warnings = [];
    const fetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example.invalid");
    };
    const { executor } = createProbeExecutor({
      baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: ENV, fetchImpl, warn: (m) => warnings.push(m),
    });
    const out = await executor.execute(ROUTE, req);
    expect(out).toMatchObject({ status: 0, ok: false, error_class: "unknown", usage: null, reported_model: null });
    expect(warnings.join(" ")).toMatch(/probe request failed/);
    expect(warnings.join(" ")).not.toContain(ENV.DXR_TEST_PROBE_KEY);
  });

  it("a response with no usage yields null, which the measure reads as silence", async () => {
    const fetchImpl = async () => ({ status: 200, async json() { return { model: "m", choices: [] }; } });
    const { executor } = createProbeExecutor({
      baseUrl: "https://api.example.invalid/v1", apiKeyEnv: "DXR_TEST_PROBE_KEY", env: ENV, fetchImpl,
    });
    const out = await executor.execute(ROUTE, req);
    expect(out.usage).toBe(null);
    expect(probeUsage(out.usage).cache_read).toBe(null);
  });
});
