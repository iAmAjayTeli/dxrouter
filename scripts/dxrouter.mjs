#!/usr/bin/env node
/**
 * `dxrouter` — the DXRouter inspection CLI (§13).
 *
 * Three commands: `sessions` (M1), `cost` and `measure` (M2). Every one of them reads.
 * The only writes in this file are the ones §19.4 requires of a measurement run — an
 * `experiments` row and a markdown report — and §13 forbids the rest: there is no
 * provider switching, no pinning, no routing policy, and no cache mutation here.
 *
 * Runs under bare node, no bundler: everything it imports resolves through relative
 * paths, and the data root still comes from the one resolver (`src/lib/dataDir.js`) via
 * `adapters/ninerouter/continuityDb.js`. That is deliberate — a CLI that guessed its own
 * path would happily inspect an empty database while the server wrote to another one.
 *
 * One consequence of bare node worth stating plainly: `open-sse` is a bundler alias, so
 * this process cannot construct the routing stack's executor. `cache_probe` therefore uses
 * `adapters/ninerouter/probeExecutor.js` — a minimal executor built from an endpoint and a
 * key-variable *name* the operator supplies, reading no stored credential. Without those
 * arguments the measure still reports blocked, and says which one is missing.
 *
 * Usage:
 *   dxrouter sessions                 open and closed sessions, newest activity first
 *   dxrouter sessions --open          only sessions still open
 *   dxrouter sessions --json          machine-readable, same fields
 *   dxrouter sessions <id>            one session with its turns
 *   dxrouter sessions --project <p>   restrict to one project root (or pr1: hash)
 *   dxrouter sessions --limit <n>     row cap (default 50)
 *
 *   dxrouter cost                     cache belief and provider cache reporting
 *   dxrouter cost --pricing           the loaded pricing records and their diagnostics
 *   dxrouter cost --provider <p> --model <m>   the stored entries for one route
 *   dxrouter cost --json              machine-readable
 *
 *   dxrouter measure --status         every research question, its verdict, and the M3 gate
 *   dxrouter measure <name>           run one measure, record it, write its report
 *   dxrouter measure <name> --fixture <path>   measure exactly this fixture file or dir
 *   dxrouter measure <name> --window 7d        restrict persisted rows to a time window
 *   dxrouter measure <name> --yes     opt in to a measure that spends real money
 *
 *   dxrouter measure cache_probe --yes --provider <p> --model <m> \
 *     --base-url <url> --api-key-env <NAME> [--protocol openai|anthropic] \
 *     [--ladder 30s,2m,5.5m,65m] [--arms above|below|both] [--repetitions <n>] \
 *     [--min-tokens <n>] [--gap <duration>]
 */

import { getContinuityStore, CONTINUITY_FILE } from "../adapters/ninerouter/continuityDb.js";
import { createClockAdapter } from "../adapters/ninerouter/clockAdapter.js";
import { getPricingRegistry } from "../adapters/ninerouter/pricingSource.js";
import { createReportWriter, EVIDENCE_DIR } from "../adapters/ninerouter/evidenceReports.js";
import { loadFixtures } from "../adapters/ninerouter/evidenceFixtures.js";
import { createProbeExecutor } from "../adapters/ninerouter/probeExecutor.js";
import { pricingKeyForProvider } from "../adapters/ninerouter/pricingKeys.js";
import { renderSessionsView } from "../continuity/cli/sessions.js";
import { renderCostView } from "../continuity/cli/cost.js";
import { renderStatus, renderRun, USAGE_LINES } from "../continuity/cli/measure.js";
import { LIVE_MEASURES, MEASURE_NAMES, isMeasure, measureStatus, replayFixture, runMeasure } from "../continuity/evidence/index.js";

const NL = String.fromCharCode(10);
const COMMANDS = ["sessions", "cost", "measure", "help"];

const USAGE = [
  "dxrouter — DXRouter inspection CLI",
  "",
  "  dxrouter sessions [<id>] [--open] [--json] [--project <root>] [--limit <n>] [--turns <n>]",
  "  dxrouter cost [--pricing] [--json] [--provider <p>] [--model <m>] [--since <ms>]",
  ...USAGE_LINES,
  "  dxrouter help",
  "",
  "Inspection only: this CLI cannot pin, switch or route anything.",
].join(NL);

function parseArgs(argv) {
  const out = {
    command: null, id: null, json: false, all: true, project: null, limit: 50, turns: 200,
    pricing: false, provider: null, model: null, since: 0, status: false, yes: false,
    fixture: null, window: null, baseUrl: null, apiKeyEnv: null, protocol: "openai",
    ladder: null, repetitions: 1, minTokens: 2048, arms: "both", gap: 5000,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--open") out.all = false;
    else if (a === "--all") out.all = true;
    else if (a === "--pricing") out.pricing = true;
    else if (a === "--status") out.status = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--project") out.project = argv[++i] ?? null;
    else if (a === "--provider") out.provider = argv[++i] ?? null;
    else if (a === "--model") out.model = argv[++i] ?? null;
    else if (a === "--since") out.since = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--limit") out.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--turns") out.turns = Number.parseInt(argv[++i] ?? "", 10);
    // §19.4 names these two in the documented command line; they existed only in the
    // document until now, and a gate that names commands nobody can run gets waived.
    else if (a === "--fixture") out.fixture = argv[++i] ?? null;
    else if (a === "--window") out.window = argv[++i] ?? null;
    // The probe's own arguments. The endpoint and the key's *variable name* are the
    // operator's to supply: nothing here reads a stored 9Router credential.
    else if (a === "--base-url") out.baseUrl = argv[++i] ?? null;
    else if (a === "--api-key-env") out.apiKeyEnv = argv[++i] ?? null;
    else if (a === "--protocol") out.protocol = argv[++i] ?? "openai";
    else if (a === "--ladder") out.ladder = argv[++i] ?? null;
    else if (a === "--arms") out.arms = argv[++i] ?? "both";
    else if (a === "--repetitions") out.repetitions = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--min-tokens") out.minTokens = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--gap") out.gap = parseDuration(argv[++i] ?? null) ?? 5000;
    else if (a === "-h" || a === "--help") out.command = "help";
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (!out.command) out.command = rest.shift() ?? "help";
  out.id = rest.shift() ?? null;
  if (!Number.isFinite(out.limit) || out.limit <= 0) out.limit = 50;
  if (!Number.isFinite(out.turns) || out.turns <= 0) out.turns = 200;
  if (!Number.isFinite(out.since) || out.since < 0) out.since = 0;
  if (!Number.isFinite(out.repetitions) || out.repetitions <= 0) out.repetitions = 1;
  if (!Number.isFinite(out.minTokens) || out.minTokens <= 0) out.minTokens = 2048;
  if (!["above", "below", "both"].includes(out.arms)) throw new Error(`--arms expects above | below | both`);
  // `--window 7d` is the same thing as `--since <epoch>`, expressed the way a person
  // thinks about it. An explicit `--since` wins, because it is the more specific.
  const windowMs = parseDuration(out.window);
  if (windowMs !== null && !out.since) out.since = Math.max(0, Date.now() - windowMs);
  else if (out.window !== null && windowMs === null) throw new Error(`--window expects a duration like 24h, 7d or 30m`);
  return out;
}

/** `30s`, `24h`, `7d`, `5.5m`, or bare milliseconds. Null when it is not a duration. */
function parseDuration(spec) {
  if (spec === null || spec === undefined || spec === "") return null;
  const match = /^([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)?$/.exec(String(spec).trim().toLowerCase());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] || "ms"];
  return Math.trunc(value * scale);
}

/**
 * Replay every fixture this host can see, once per fixture, against the loaded pricing.
 *
 * The pricing key comes from the fixture's own declaration (`pricing_key`, else its
 * `provider`/`protocol` alias run through the one alias map). An unmapped alias resolves
 * to the `default` record — `mechanism: none` — which is the §9.3 no-file path and yields
 * a replay with no cache belief rather than a replay priced against a neighbour (I4).
 *
 * `fixture_source` travels with every replay so a measure can say out loud that its
 * population is synthetic. This repository ships only synthetic fixtures.
 */
function buildReplays({ registry, fixture = null }) {
  // `--fixture` names the whole population rather than ranking above the shipped ones, so
  // an operator measuring their own captured fixtures cannot silently get this
  // repository's synthetic ones counted into the same `n`.
  const { fixtures, diagnostics, dirs } = loadFixtures({ dir: fixture });
  const replays = [];
  for (const fixture of fixtures) {
    const alias = fixture.pricing_key ?? fixture.provider ?? fixture.protocol ?? null;
    const pricingKey = fixture.pricing_key ?? pricingKeyForProvider(alias) ?? "default";
    try {
      replays.push(
        replayFixture({
          fixture,
          registry,
          pricingKey,
          provider: alias,
          model: fixture.model ?? null,
          startAt: 0,
        }),
      );
    } catch (e) {
      diagnostics.push({ file: fixture.__file, message: `replay failed: ${e.message}` });
    }
  }
  return { replays, diagnostics, dirs, count: fixtures.length };
}

/** The arguments each measure needs, assembled from what this host can actually supply. */
function measureArgs(name, { store, clock, registry, replays, args, probe }) {
  if (name === "coverage") return { store, replays, since: args.since, provider: args.provider };
  // Q2's population is either the observed M1 record or the fixtures, never the two added
  // together (the measure blocks on `mixed_population` if it ever is). `--fixture` selects
  // fixtures explicitly; with no `--fixture` the store is the population, which is the only
  // input that can answer Q2 about this deployment.
  if (name === "prefix_stability") {
    return args.fixture ? { replays } : { store, since: args.since, limit: args.limit };
  }
  if (name === "arithmetic_accuracy") return { replays };
  if (name === "return_rate") {
    return {
      store,
      replays,
      registry,
      pricingKey: args.provider ? pricingKeyForProvider(args.provider) : null,
      limit: args.limit,
      // Moves are harvested from persisted results, so the window applies to them too.
      since: args.since,
    };
  }
  // `cache_probe` is the one measure that sends requests. `--yes` is the opt-in, and the
  // executor is built only from an endpoint and a key-variable name the operator named
  // (`--base-url`, `--api-key-env`). With neither supplied there is no executor, and the
  // measure reports blocked with `no_executor` rather than half-running.
  if (name === "cache_probe") {
    return {
      optIn: args.yes === true,
      executor: probe?.executor ?? null,
      clock,
      registry,
      pricingKey: args.provider ? pricingKeyForProvider(args.provider) : null,
      route: args.provider && args.model ? { provider: args.provider, model: args.model } : null,
      ladder: args.ladder,
      arms: args.arms,
      repetitions: args.repetitions,
      minTokens: args.minTokens,
      gapMs: args.gap,
      // The engine owns no timer (I1); a real ladder needs a real wait.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }
  return {};
}

async function runSessions(args) {
  const store = await getContinuityStore();
  const view = renderSessionsView({
    store,
    clock: createClockAdapter(),
    options: { id: args.id, all: args.all, json: args.json, project: args.project, limit: args.limit, turns: args.turns },
  });
  console.log(view.text);
  if (!args.json && view.count === 0) {
    // Say where we looked. "no sessions" plus a path is a diagnosis; without the path
    // it is a mystery.
    console.log(`(database: ${CONTINUITY_FILE})`);
  }
  return view.count === 0 && args.id ? 1 : 0;
}

async function runCost(args) {
  const store = await getContinuityStore();
  const view = renderCostView({
    store,
    registry: getPricingRegistry(),
    clock: createClockAdapter(),
    options: { pricing: args.pricing, json: args.json, provider: args.provider, model: args.model, since: args.since },
  });
  console.log(view.text);
  if (!args.json && !args.pricing && view.count === 0) console.log(`(database: ${CONTINUITY_FILE})`);
  return 0;
}

async function runMeasureCommand(args) {
  const store = await getContinuityStore();
  const clock = createClockAdapter();

  if (args.status || !args.id) {
    const status = measureStatus({ store });
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(renderStatus(status));
      console.log("");
      console.log(`reports: ${EVIDENCE_DIR}`);
      console.log(`a verdict is set by a person, not by a run: experiments.setVerdict(id, verdict, reviewed_by)`);
    }
    return status.gate.open ? 0 : 1;
  }

  if (!isMeasure(args.id)) {
    console.error(`unknown measure: ${args.id}`);
    console.error(`expected one of: ${MEASURE_NAMES.join(", ")}`);
    return 2;
  }
  if (LIVE_MEASURES.includes(args.id) && !args.yes) {
    console.error(`${args.id} sends real provider requests and costs real money.`);
    console.error(`re-run with --yes to opt in. Nothing was sent.`);
    return 2;
  }

  const registry = getPricingRegistry();
  const { replays, diagnostics, dirs, count } = buildReplays({ registry, fixture: args.fixture });
  for (const d of diagnostics) console.error(`[dxrouter] ${d.file}: ${d.message}`);

  // Built before the run so the reason it could not be built is printed once, plainly,
  // instead of arriving as a blocked reason with no explanation.
  let probe = null;
  if (args.id === "cache_probe") {
    probe = createProbeExecutor({ baseUrl: args.baseUrl, apiKeyEnv: args.apiKeyEnv, protocol: args.protocol });
    if (probe.executor) console.log(`probe endpoint: ${probe.endpoint} (key from $${args.apiKeyEnv || "DXR_PROBE_API_KEY_ENV"})`);
    else console.error(`[dxrouter] no probe executor: ${probe.reason}`);
  }

  const run = await runMeasure({
    store,
    clock,
    measure: args.id,
    args: measureArgs(args.id, { store, clock, registry, replays, args, probe }),
    writeReport: createReportWriter(),
  });

  console.log(renderRun(run));
  console.log("");
  console.log(`fixtures: ${count} from ${dirs.length ? dirs.join(", ") : "(none found)"}`);
  if (run.report_path) console.log(`report: ${run.report_path}`);
  // A recorded run is not an answer. §19.4: "A run does not unblock anything by existing."
  console.log(`recorded as ${run.row.id} with verdict "${run.row.verdict}" — a person grades it.`);
  return run.result.status === "error" ? 1 : 0;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message || e));
    console.error(USAGE);
    return 2;
  }

  if (args.command === "help" || args.command === "--help") {
    console.log(USAGE);
    return 0;
  }
  if (!COMMANDS.includes(args.command)) {
    console.error(`unknown command: ${args.command}`);
    console.error(USAGE);
    return 2;
  }

  if (args.command === "sessions") return runSessions(args);
  if (args.command === "cost") return runCost(args);
  return runMeasureCommand(args);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`[dxrouter] ${e?.stack || e}`);
    process.exitCode = 1;
  });
