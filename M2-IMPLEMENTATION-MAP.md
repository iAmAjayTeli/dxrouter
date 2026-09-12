# M2 implementation map — cache state, cache pricing and evidence

`FINAL-ARCHITECTURE.md` v1.1 is the source of truth. This map is the "file →
responsibility → reason" plan required before coding, written after reading the
document and the actual M0/M1 code (which does not always match it — the deltas are
listed at the bottom).

**Scope discipline.** M2 is a substrate milestone, like M1 before it. It records what a
provider reported about its own cache, keeps a belief about each prefix layer on each
route, loads per-provider cache pricing that can degrade one provider without
degrading the router, and builds the local measurement harness that a later milestone's
numbers have to come from. It does **not** decide anything: no `ContinuityCost`, no
candidate ranking, no STAY/MOVE/WAIT, no shadow routing, no compatibility contract, no
Session Rebase, no capacity forecasting, no Drift Sentinel, no new providers. Legacy
9Router `accountFallback` remains authoritative and `DXR_ENGINE` stays off. Pricing
terms are *carried* so M3 can price with them; `economics_available` is the flag that
says whether it may, and nothing in M2 reads it to produce money.

The question M2 answers, and the only one: **"what do we currently believe about the
cache state of this session/model/provider, and how strong is the evidence?"**

## New — continuity engine (pure; may import only `continuity/**` and `node:`)

| File | Responsibility | Reason |
|---|---|---|
| `continuity/cache/confidence.js` | `CacheConfidence` (`confirmed / assumed / expired / unknown`), the `CACHE_EVIDENCE` vocabulary, the legal transitions, `raiseWithEvidence`, `degradeCacheConfidence`, `assertConfidenceEvidence`. | §4.1. I3 has to be structural, not remembered: `confirmed` is unreachable except through an evidence value a provider produced, and `assertConfidenceEvidence` throws on the pairing that would smuggle it in. |
| `continuity/cache/policy.js` | The tunables in one injected object: staleness window, expiry deletion grace, half-life degrade switch, retention. | Same reasoning as `session/policy.js`. §9.3 fixes 90 days and §12.3 fixes the 1 h grace; the rest are chosen here and visible in one place rather than scattered as magic numbers. |
| `continuity/cache/entry.js` | One `cache_entries` row: validation, freezing, `expiresAt`/`deleteAfter`, `entryState` (effective vs stored confidence, §4.2 half-life), and `applyEvidence` — the single fold from an observation to a new entry. | §12's key is `(provider, model, prefix_hash, layer)`, not the session: two sessions sending the same tools block to the same model are looking at the same upstream cache. Expiry is computed, never stored, because the only writer is a request path that may not run for hours. |
| `continuity/cache/estimator.js` | `planCacheWrites`: which layers a route could plausibly have cached, with token counts and TTL, and why each ineligible one was excluded (`INELIGIBLE`). | The bridge from M1's layers to M2's entries. A provider with no verified cache model yields an **empty** plan, not a plan of zeroes (I4); eligibility is cumulative in prefix order because a provider caches a prefix, not a set of blocks. |
| `continuity/cache/ledger.js` | The CacheLedger: given M1 prefix layers plus a candidate route, report the warm region, its tokens, its confidence and its evidence — and nothing else. | The module the M2 goal names. The warm region is a prefix and the walk stops at the first cold or diverged layer, so a warm `messages` layer behind a changed `system` layer is correctly worth nothing. |
| `continuity/cache/observer.js` | `observeCacheResult`: classify what the provider reported (`classifyCacheResult`), attribute a reported read back onto prefix layers (`attributeRead`, `planEvidenceEntries`), write one `turn_results` row and fold the result into `cache_entries`, in one transaction. The one entry point the live path calls. | §9's post-execution triad plus the write case, in one piece rather than spread across the adapter — the classification is exactly where an assumption could quietly become a measurement. |
| `continuity/cache/index.js` | The M2 cache surface, in the order a real turn uses it. | One door. Everything reachable from here is an observation or a belief; no cost, no candidate, no decision. |
| `continuity/cache/pricing/yaml.js` | A flat-subset YAML reader that rejects anything outside the subset **with a line number**. | The records must be human-editable and human-auditable, and a router that cannot start without a YAML package on npm is worse than one that reads the subset it actually uses. |
| `continuity/cache/pricing/schema.js` | The §9.2 record: field list, validation, freezing — and the decision that an unverifiable record becomes `mechanism: none` rather than a lenient record. | I4. A record nobody can verify must contribute zero claimed economics while leaving the provider fully routable. |
| `continuity/cache/pricing/source.js` | `keys()`/`read(key)` — `shippedSource()` (records committed beside the engine, resolved from `import.meta.url`), `createDirectorySource(dir)`, `createMemorySource(obj)`. | The smallest thing a test can fake. I1 stops the engine knowing a *data root*, not reading its own assets. |
| `continuity/cache/pricing/loader.js` | `loadCacheModels`: the §9.3 outcome table, one row per provider, plus a registry version and a per-provider diagnostic. Never throws. | "A bad or missing provider entry must degrade that provider's cache-awareness, not crash the entire router." Every failure mode ends with a routable provider and a recorded reason. |
| `continuity/cache/pricing/index.js` | The pricing door. | Four files behind one import, so callers cannot reach past the loader into the schema. |
| `continuity/cache/pricing/data/*.yaml` (11) | The shipped records: `anthropic` (explicit) and `openai` (implicit), eight vendor records that claim no cache economics, and the `default` fallback. | §9.2. Each names its source, its verification method, `verified_at` and `verified_by`, so staleness is computable and a correction is a text edit. |
| `continuity/evidence/questions.js` | The numbered §23 questions and which milestone each blocks. | "M3 does not start until `measure --status` reports `sufficient` with a `reviewed_by` for Q1–Q3" is unenforceable as a table in a document. In code, read by the status command, it is mechanical. |
| `continuity/evidence/harness.js` | The spine around a measure: versions that keep a result interpretable later, run ids (`exp_<sha16>`), the `experiments` row builder, the review rules, the `blocked` vocabulary. | §19.4. A measure is a reducer; everything that makes its output *auditable* belongs outside it, once. |
| `continuity/evidence/fixtures.js` | The fixture *program* format and its one interpreter: per-turn history operations, messages as `[role, bytes, id]` expanded to deterministic seeded filler. | A fixture must describe real traffic *structure* without copying anything anyone wrote, and identity is what the engine keys on, so `id` equality is the whole content model. One interpreter, so a fixture cannot mean two things. |
| `continuity/evidence/replay.js` | The one replay: turn by turn, reconstruct what the engine would have believed, with `decide` as a null injection point. | No network, no database, no Decision. M3 adds its stage here rather than growing a second replayer beside this one. |
| `continuity/evidence/report.js` | The markdown a run leaves behind — sample size, error band, synthetic-vs-real, every `blocked` reason, before the headline number. | A report that led with the figure and buried the provenance would make grading harder than not reporting at all. |
| `continuity/evidence/measures/coverage.js` | Q1: what fraction of provider responses carry usable cache usage fields, from persisted `turn_results` and from fixtures. | Whether `confirmed` evidence is obtainable at all. Until measured, "the provider reports cache reads" is a documentation claim. |
| `continuity/evidence/measures/prefixStability.js` | Q2: how many turns pass before each layer is first invalidated; fraction of turns leaving the prefix front untouched. | §23 requires at least three project kinds before this answers anything, and the measure says so in its own output. |
| `continuity/evidence/measures/returnRate.js` | Q3: P(the session returns inside the cache window), over inter-turn gaps, with the window taken from the pricing registry. | A warm prefix on a session that never comes back in time is worth nothing, whatever the ledger believes. |
| `continuity/evidence/measures/arithmeticAccuracy.js` | The §20 band: replayed cache token counts against what providers actually **reported**, per turn; unreported turns counted separately rather than scored as perfect. | §20 states the M2 acceptance criterion against this number, so the comparison has to be narrow and the abstentions have to be visible. |
| `continuity/evidence/measures/cacheProbe.js` | The only measure that sends real requests: `planProbe` (requests, approximate tokens, "real money"), the refusals, `probeFiller`. | §19.4 plus the legitimacy rules. Every refusal is evaluated *before* any code that could send something, and a refusal records nothing, so it can never be read later as a measurement. |
| `continuity/evidence/measures/index.js` | The measure registry, keyed by name, each entry naming its question. | `measure --status` and the CLI both enumerate measures; a registry keeps "which question does this answer" beside the code that answers it. |
| `continuity/evidence/index.js` | `runMeasure` → `experiments` row with `verdict: "pending"` + a report; `measureStatus` → the gate. | The harness never grades its own run. That sequence is the milestone gate, so it lives behind one import. |
| `continuity/store/sqlite/repositories/cacheRepo.js` | Parameterized `cache_entries` reads/writes, upsert on the four-column key, per-route and per-confidence aggregates, expiry sweep. | The M2 half of the store M0 created empty. Aggregates are computed in SQL per confidence value so no caller can accidentally sum `assumed` into `confirmed` (I3). |
| `continuity/store/sqlite/repositories/turnResultsRepo.js` | `turn_results`: what a provider actually did, keyed `(session_id, turn_idx, seq)`, with `attempt_id` as the forward link. | §12.1 puts this in `attempts`, whose `decision_id` is `NOT NULL REFERENCES decisions(id)`; M2 produces no Decision and §12.3 forbids rebuilding a released table. See deviation 1. |
| `continuity/store/sqlite/repositories/experimentsRepo.js` | One row per run; `setVerdict` refuses a graded verdict without a `reviewed_by`. | "A run does not unblock anything by existing." The rule belongs in the write path, not in a convention somebody follows. |
| `continuity/store/sqlite/repositories/fixturesRepo.js` | The registered workloads a measure replays, with `source` ∈ `synthetic / captured`, written by the registrant, never inferred. | §15. A result derived from synthetic material must be unreadable as a real-workload measurement. |
| `continuity/store/sqlite/migrations/003-cache-m2.js` | Forward-only: the M2 evidence columns on `cache_entries`, the `turn_results` table, the evidence pair, indices — each guarded by a `PRAGMA table_info` read. | §12.3. Nothing dropped, rewritten or back-filled; an M1 database opened by M2 code keeps every row and 001/002 keep their released bodies. |
| `continuity/cli/cost.js` | Pure formatter for `dxrouter cost`: belief table, coverage table, pricing table, `--json`. Inspection only. | §13. There is no flag here that pins a route or claims a saving — a CLI is the easiest place for authority to leak in unnoticed. |
| `continuity/cli/measure.js` | Pure formatter for `dxrouter measure` and `--status`: verdict column before the number, reviewer named or absent, the blocking questions listed. | A status table that led with a figure would let an ungraded run read as settled evidence, which is the exact failure §19.4 exists to prevent. |

## Modified — continuity engine

| File | Change | Reason |
|---|---|---|
| `continuity/prefix/tokens.js` | Export `intOrNull` — an integer, or `null` when there is no value. | The three cache/evidence files each carried their own `Number.isFinite(Number(v))` version, and `Number(null)` is `0`. See deviation 8; it belongs beside `TOKEN_PROVENANCE` because it is the same distinction. |
| `continuity/store/sqlite/schema.js` | The M2 DDL constants (`turn_results`, the evidence pair, the `cache_entries` evidence columns) and their registration; the `usage_provenance` comment corrected to `measured`. | Schema text stays in one pure module. The comment said `reported`, a vocabulary that exists nowhere in the code. |
| `continuity/store/sqlite/migrations/index.js` | Append `003`. | `assertMigrationsWellFormed` requires contiguous versions. |
| `continuity/store/sqlite/index.js`, `continuity/store/index.js` | Export the four new repositories and register the new tables. | The store is the only door to persistence. |
| `continuity/flags.js` | Add the top-level `cacheTracking` flag (`DXR_CACHE_TRACKING`, default on, engine-independent); keep `cacheEconomics` an *unimplemented* `MILESTONE_FLAGS` entry. | §20 gives M2 the rollback `DXR_CACHE_TRACKING=off`, which only means something if observation is on by default and not clamped by an engine that is off. Consumption of the economics is M3's, so asking for it is *reported* at boot rather than silently granted. |

## Modified / new — adapters and host (the only bilingual layer)

| File | Responsibility | Reason |
|---|---|---|
| `adapters/ninerouter/cacheObserver.js` (new) | `observeProviderResult`: normalize 9Router usage into the engine's shape, resolve the pricing key, call `observeCacheResult`, swallow everything. Returns nothing routable. | Mirrors `sessionObserver`. `accountFallback` has already chosen the provider and model by the time this runs, and there is no path here that could change that. `toEngineUsage` fills every field, using explicit `null` for an absent count. |
| `adapters/ninerouter/pricingKeys.js` (new) | The 9Router provider alias → §9.2 vendor pricing key map. | Split out of `cacheObserver.js` mechanically: that file imports `normalizeUsage` from `executorAdapter.js` → `open-sse`, a bundler/vitest alias that does not resolve under bare node, and the `dxrouter` CLI needs the map. A map is not a reason to drag the routing engine into a CLI. See deviation 2. |
| `adapters/ninerouter/pricingSource.js` (new) | Shipped records, then an operator override directory under the one data root; the override wins per key. | §9.2's "correctable without rewriting routing logic", in practice: drop a corrected `anthropic.yaml` into `<data root>/cache-pricing/` and the next start uses it. No release, no patch. |
| `adapters/ninerouter/evidenceFixtures.js` (new) | Where replay fixtures are read from on this host (three directories, precedence order). | The fixture *format* is engine knowledge; the fixture *location* is a host path, which I1 forbids the engine from knowing. |
| `adapters/ninerouter/evidenceReports.js` (new) | Where a run's markdown report lands, under the one data root. | §19.4 requires a report on disk beside the row. The row is the machine's memory; the report is what a person reads before typing a verdict. |
| `src/lib/dxr/cache.js` (new) | App-side guarded entry: `rememberTurn` / `recallTurn` (a `WeakMap` on the live `Request`), `makeProviderResultObserver`, the `cacheTracking` gate, the non-object guard, fire-and-forget scheduling. | Mirrors `src/lib/dxr/sessions.js`: `process.env` binding stays in `src/lib/dxr/`. The observation happens when the body arrives and the usage arrives when the stream ends, several frames later; the live request object is already the identity that correlates them, and a `WeakMap` means an abandoned request takes its entry with it — no sweeper, no leak. |
| `src/lib/dxr/sessions.js` (mod) | Accept `retain` and file the M1 observation promise under it via `rememberTurn`. | The result path needs the M1 turn, and M1 already produced it. Re-deriving it from the response would build continuity state from the wrong direction. |
| `src/sse/handlers/chat.js` (mod) | Pass `retain: request` to `observeChatTurn`; pass `onProviderResult: makeProviderResultObserver(request)` into the engine call. | One seam each, in the file all six `/v1` routes funnel through. Neither value is awaited and neither return value is read. |
| `open-sse/handlers/chatCore.js` (mod) | Carry `onProviderResult` through `sharedCtx` to the response handlers. | Forwarding only: `chatCore` never calls it. The comment says so, and a protocol test pins it. |
| `open-sse/handlers/chatCore/requestDetail.js` (mod) | `saveUsageStats` invokes `onProviderResult` in a `try/catch` **above** its `if (!tokens …) return;` early return. | A zero-token or failed attempt is exactly the evidence the coverage measure needs, so the notification must not sit behind the guard that drops it. Swallowed, because observation may never fail a completion. |
| `open-sse/handlers/chatCore/{streamingHandler,nonStreamingHandler,sseToJsonHandler}.js` (mod) | Thread `onProviderResult` into their `saveUsageStats` calls. | The three response shapes are three call sites; missing one would silently halve the evidence. |
| `scripts/dxrouter.mjs` (mod) | `dxrouter cost` and `dxrouter measure` host entries: open the store, build the registry from `pricingSource`, run the pure formatters, exit non-zero while the M3 gate is closed. | §13. A closed gate must not look like success to CI, and the money guard has to be the process's own behaviour, not a renderer's. |
| `package.json`, `tests/package.json` (mod) | `test:m2`. | A named gate, mirroring `test:m1`. |

## Tests (all under `tests/`, vitest, groups A–E and J of the brief)

`continuity/cache-ledger.test.js` (A, 46 — entry lifecycle, confidence transitions,
estimator, ledger, prefix invalidation) · `continuity/cache-pricing.test.js` (B, 33 —
the §9.3 outcome table, staleness, malformed YAML with line numbers, unknown-provider
behaviour, registry versioning) · `continuity/cache-persistence.test.js` (C, 23 —
migrations against a real SQLite file, upsert on the four-column key, the null-vs-zero
regression) · `continuity/evidence-harness.test.js` (D, 28 — replay determinism, the
four measures, the review rules, synthetic labelling, the probe refusals) ·
`continuity/cli-cost-measure.test.js` (E, 20 — both formatters plus seven spawned-process
tests, including the money guard) · `protocol/m2-no-routing-change.test.js` (J, 16 —
the live path: identical engine arguments with observation on and off but for the one
callback, persisted rows, fail-open on garbage, no belief reader anywhere under `src/`
or `open-sse/`) · `continuity/tokens.test.js` (mod, 15 — `intOrNull`).

Supporting material: `tests/continuity/helpers/harness.js` extended with `observe`,
`store`, `clock`, `tick`, `at` so a cache test can drive a real M1 turn and then a real
provider result against a real SQLite file; `tests/fixtures/cache/*.json` — two
fixtures, both labelled `synthetic`, one where the provider reports and one where it
stays silent.

Verified: `continuity/ protocol/` → 24 files, 482 tests, all passing. `npm run test:m0`
(security/ continuity/ protocol/) → 31 files, 697 tests, all passing.
`npm run lint:boundary` → 62 files in `continuity`, no forbidden imports. `npx eslint`
clean on every changed product file.

## Where the document and the M0/M1 code differ (decided, not assumed)

1. **`turn_results`, not `attempts`.** §12.1 records a provider attempt in `attempts`,
   whose `decision_id` is `TEXT NOT NULL REFERENCES decisions(id)`. M2 produces no
   Decision — that is M3 — and satisfying the constraint would mean either writing a
   fake Decision row (an I2 violation: the decision would not be the trace of anything)
   or rebuilding a released table, which §12.3's forward-only rule forbids. So results
   land in an `attempts`-shaped table keyed by the M1 turn, `(session_id, turn_idx, seq)`,
   with a nullable `attempt_id` as the forward link M3 fills in. `attempts` stays empty
   and untouched.
2. **Ten vendor pricing keys versus 81 9Router aliases.** §9.2 names vendors; the
   registry names aliases, many of them resellers or gateways whose cache semantics are
   not the upstream vendor's. Guessing by substring would be exactly the "silently fall
   back to another provider" the invariants forbid. So `PRICING_KEY_BY_ALIAS` is an
   explicit, conservative map, and an unmapped alias takes the §9.3 "no file" path
   through the `default` record: `mechanism: none`, zero claimed economics, fully
   routable.
3. **A reported read is attributed to a prefix *region*, not to layers individually.**
   A provider reports one `cache_read` count for the whole prefix, and the boundary
   rarely falls on a layer edge. `attributeRead` walks in prefix order and
   deliberately **under**-attributes: a layer straddling the reported boundary is left
   out. An estimate can therefore never buy a `confirmed`, which is what keeps I3
   arithmetic-proof rather than convention-proof.
4. **Partial warmth is a prefix, and the ledger says so in one field.** §4 has no name
   for "the tools block is warm and the messages are not", but it is the common case.
   The ledger reports the warm region's last layer plus its own confidence, rather than
   a per-layer set a caller could sum out of order.
5. **`expectation_basis` on the measure output.** Not in §19.4. A number needs to say
   what it was compared *against* — a provider's documentation, a shipped fixture's own
   declared expectation, or a live report — or a reader cannot tell a validated
   reconstruction from a self-consistent one. Added because §15's honesty rule is
   unenforceable without it.
6. **`arithmetic_accuracy` is filed under Q6 alone, though §23 lists it under Q1 too.**
   A run of it cannot establish that providers report cache fields at all — it is only
   computable on the turns where they already did. Letting it write the latest Q1 row
   would let an arithmetic check stand in for the coverage evidence that gates M3, which
   is the one substitution this harness exists to prevent.
7. **The fixture interpreter lives in the engine, the fixture location in the adapter.**
   M1 put a fixture loader in `tests/continuity/helpers/fixtures.js`. Replay needs the
   same format at runtime, and two interpreters would drift, so the format moved to
   `continuity/evidence/fixtures.js` and only the *paths* stayed host-side. The M1 test
   helper now delegates rather than parsing.
8. **`int(null)` returned `0` in three engine files, and it mattered.** Each of
   `cache/observer.js`, `cache/entry.js` and `evidence/replay.js` carried
   `Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null`; `Number(null)` is `0` and
   `0` is finite. Because the adapter's `toEngineUsage` fills every field with an
   explicit `null`, every silent provider on the live path was persisted as four
   *measured zeros*: `usage_provenance` read `measured`, `classifyCacheResult` saw a
   report, and §19.4's coverage measure — which counts silence as `usage_cache_read IS
   NULL` — would have found none, permanently, on live traffic. Groups A–D missed it
   because their fixtures *omit* fields (`undefined` → `NaN` → `null`); only the live-path
   protocol suite exercises the adapter's shape. Fixed with one exported `intOrNull` in
   `continuity/prefix/tokens.js` and three aliases to it. This is an I4 bug, not a style
   one, and it is the concrete justification for the brief's "prefer tests that inspect
   actual persisted state".
9. **A non-object provider notification writes nothing.** `makeProviderResultObserver`
   rebuilt every field with `?? null`, so `null` or a string arriving from the response
   path became a well-formed "an attempt happened and the provider stayed silent" row —
   a measurement nobody took. It is now dropped at the top of the callback. An object
   that merely *reports* nothing is still recorded, as what it is: an attempt whose
   provider and counts could not be read (`mechanism: none`, `cache_confidence: unknown`).
10. **`applyEvidence` keeps the evidence that earned a `confirmed`.** Found by the
    persistence suite. `raiseWithEvidence` deliberately does not demote a row a provider
    once confirmed, so a silent turn following a reported write would have left
    `confidence: confirmed` beside `evidence: assumed_write` — an I3 violation on its
    face, and, because `assertConfidenceEvidence` rejects that pair, a throw on the most
    ordinary sequence there is. The evidence column now keeps naming the report, and
    `confirmed_at` moves only on a provider report.
11. **No captured provider traffic exists in this workspace.** Every shipped fixture is
    labelled `synthetic`. The §20 acceptance criterion — replay within 5% of counts
    providers actually reported — is therefore reported **BLOCKED**, not passed: every
    shipped fixture declares `expectation_basis: "engine_estimator"`, so its turns are
    scored apart and named in the notes, because a 0% band from comparing an estimator
    against itself must not read as a measurement of any vendor. Deriving fixtures from the one available local agent transcript
    was refused as a source, as in M1 deviation 8.
12. **The M3 gate is closed and `measure --status` exits 1.** All four runnable measures
    produce `verdict: pending` with no reviewer, and Q4/Q5/Q7/Q8/Q9 report `(no measure)`.
    Grading Q1–Q3 `sufficient` needs live credentials, real spend and a named human, so
    that criterion is reported **BLOCKED** as well. Nothing in M2 can open the gate on
    its own behalf, and that is the intended shape.
