# M1 implementation map — session identity and prefix layers

`FINAL-ARCHITECTURE.md` v1.1 is the source of truth. This map is the "file →
responsibility → reason" plan required before coding, written after reading the
document and the actual M0 code (which does not always match it — the deltas are
listed at the bottom).

**Scope discipline.** M1 is an observation/substrate milestone: it resolves session
identity, hashes prefix layers, counts tokens with provenance, and persists sessions
and turns. It does **not** decide anything. No cache ledger, no pricing, no
`ContinuityCost`, no candidate ranking, no STAY/MOVE/WAIT, no shadow routing, no
probes, no rebase, no forecasting, no sentinel, no new providers. Legacy 9Router
routing stays authoritative and `DXR_ENGINE` stays off.

## New — continuity engine (pure; may import only `continuity/**` and `node:`)

| File | Responsibility | Reason |
|---|---|---|
| `continuity/canonical/serialize.js` | Canonical JSON bytes + `sha256` digest: recursive byte-wise key ordering, NFC strings, absent vs null distinct, minimal escaping, no BOM. | §10.3 is the established canonicalization contract. Hashing needs it, and it must live in one place so a layer hash and a future decision hash cannot disagree. |
| `continuity/prefix/tokens.js` | Per-layer token count with provenance `measured / estimated / unavailable`; deterministic byte-based estimator; optional injected tokenizer for `measured`. | §6 of the M1 brief: a count may never claim precision it does not have, and no heavyweight tokenizer dependency may be added for M1. |
| `continuity/prefix/hasher.js` | Three independent layer hashes (`tools`, `system`, `messages`) plus the per-message digest chain and `computePrefixLayers()`. | §9.1 prohibits one whole-request hash; the chain is what makes a prefix-extension check possible without storing message bodies. |
| `continuity/prefix/extension.js` | Deterministic prefix-extension classification: `identical / extension / divergence / shortened / indeterminate` plus divergence index. | §3 of the brief: message *count* comparison is explicitly forbidden; reorder and edited-history must both come out as non-continuation. |
| `continuity/prefix/invalidation.js` | Prefix-ordered invalidation set (tools → system → messages) recorded per turn. | §9.1 table. Recorded only — no cache behaviour, no cost. |
| `continuity/identity/confidence.js` | `IdentityConfidence` enum, ordering, one-step `degrade()`. | §4.1/§4.2; §12.2 needs "degraded one step" to be a single defined operation. |
| `continuity/identity/sessionId.js` | Validation/normalization of client-supplied session ids and project roots: NFC, length cap, strict charset whitelist, control-character rejection, secret-shaped rejection, project-root hashing. | §2: ids must never become a path or SQL vector and must not carry secrets. A whitelist (not a blacklist) is what makes path/SQL safety structural. |
| `continuity/identity/sessionResolver.js` | The pure resolver: explicit header, then strong inference, then weak inference exactly as §4.2 defines it, then a new session with `unknown`. Returns an action, a confidence, a source and boundary metadata. Pure: no store, no clock, no id generation. | §2 priority order, §4 "do not invent heuristics", and the safety rule FALSE SPLIT beats FALSE CONTINUATION. Purity is what makes every branch testable. |
| `continuity/session/policy.js` | The tunables in one injected object: idle timeout, compaction shrink ratio, lock stale window, lock acquire budget, retention days, chain cap. | v1.1 fixes some of these (60 s / 250 ms / 30 days) and leaves others open; a single place makes the open ones visible instead of scattered magic numbers. |
| `continuity/session/lifecycle.js` | States `new -> active -> reevaluating -> closed`, the five close reasons, transition legality, idle-close and compaction predicates. | §5. `reevaluating` is typed but never produced in M1, the same way `REBASE` is typed and unreachable. |
| `continuity/session/locks.js` | Advisory per-session lock over `sessions.lock_owner`/`lock_at`: single atomic conditional UPDATE, 60 s stale takeover, release, 250 ms budget. | §12.2. One conditional UPDATE (not read-then-write) is what makes takeover race-free without an external locking dependency. |
| `continuity/session/observer.js` | `observeTurn()`: hash layers, resolve identity, take the lock, persist session and turn in one transaction, return a content-free record. | §12 of the brief: the live path may observe and persist and nothing else. One entry point keeps that boundary auditable. |
| `continuity/session/sweeper.js` | Idle close (`idle_timeout`), stale-lock release, orphan close (`swept`), turn retention. | §12.3 retention plus §4.3 "the sweeper is the only component permitted to mutate closed sessions". |
| `continuity/store/sqlite/repositories/sessionsRepo.js` | Parameterized session reads/writes, including open-session candidate lookup by layer hashes. | Repositories are the M1 half of the store that M0 deliberately left empty. |
| `continuity/store/sqlite/repositories/turnsRepo.js` | Turn insert with in-transaction index allocation, turn counts, retention delete. | `PRIMARY KEY (session_id, idx)` needs the index allocated inside the write transaction, not read beforehand. |
| `continuity/store/sqlite/repositories/prefixStateRepo.js` | Per-session latest prefix state (layer hashes, message count, capped digest chain). | The prefix-extension check needs the previous chain; keeping it in one row per session (not per turn) bounds growth and keeps `turns` append-only. |
| `continuity/store/sqlite/migrations/002-sessions-m1.js` | Forward-only migration: M1 columns on `sessions`/`turns`, new `session_prefix` table, indices. | §12.3 forward-only numbered migrations, no ORM, no destructive step. The released `001` must not be edited. |
| `continuity/cli/sessions.js` | Pure formatter for `dxrouter sessions` (table and JSON views, privacy-aware project root). | §13 inspection only. Pure because I1 forbids the engine knowing a file path. |

## Modified — continuity engine

| File | Change | Reason |
|---|---|---|
| `continuity/store/sqlite/schema.js` | Add the M1 DDL constants (`session_prefix`, M1 column lists) and register the new table. | Schema text stays in one pure module; `001` keeps its released body. |
| `continuity/store/sqlite/migrations/index.js` | Append `002`. | `assertMigrationsWellFormed` requires contiguous versions. |
| `continuity/store/sqlite/index.js`, `continuity/store/index.js` | Export the repositories and the M1 surface. | The store is the only door to persistence. |
| `continuity/flags.js` | Add the top-level `sessions` flag (`DXR_SESSIONS`, default on, engine-independent, observation-only). | §20 gives M1 the rollback `DXR_SESSIONS=off`, which only means something if observation is on by default and not clamped by an engine that is off. `sessionInference` stays an *unimplemented* `MILESTONE_FLAGS` entry, so *engine consumption* of identity remains clamped off — see deviation 7. |
| `continuity/ports/normalizedRequest.js` | Widen `client_hint` with `project_root`. | I1 says widen a port instead of adding an import. The engine cannot read a header itself. |

## Modified / new — adapters and host (the only bilingual layer)

| File | Responsibility | Reason |
|---|---|---|
| `adapters/ninerouter/normalizeAdapter.js` (mod) | `x-dxr-session` first in `SESSION_HEADERS`; extract the project-root header. | §2 makes `X-DXR-Session` *the* explicit identity header; it is absent from the M0 list. |
| `adapters/ninerouter/sessionObserver.js` (new) | Host wiring: open the store, resolve owner/salt/policy, normalize, call `observeTurn`, swallow everything. | Ports cannot see paths, env or process identity; the adapter can. Fail-open is mandatory — observation may never change a response. |
| `src/lib/dxr/sessions.js` (new) | App-side guarded entry (`observeChatTurn`), flag/env reading, memoised store, never throws. | Mirrors `src/lib/dxr/flags.js`: `process.env` binding stays in `src/lib/dxr/`. |
| `src/sse/handlers/chat.js` (mod) | One guarded observation call after auth/body parse, before dispatch. | All six `/v1` routes funnel through `handleChat`, so one seam covers them; placing it after auth means unauthenticated noise never creates sessions. |
| `scripts/dxrouter.mjs` (new) | `dxrouter sessions` host entry: open the store, read rows, print the output of the pure formatter. | §13. The root `package.json` is private with no `bin`; the script plus a `bin` entry makes the command runnable without touching the `cli/` package. |
| `scripts/derive-session-fixture.mjs` (new) | Derive a **hash-only** fixture from a local agent transcript (no prompt content stored). | §15 demands honesty about real vs synthetic. Content-free derivation is the only way to use real local traffic without committing prompts. **Never run in this workspace** — see deviation 8. |
| `adapters/ninerouter/continuityDb.js` (mod) | Import `src/lib/db/paths.js` and `version.js` by relative path, not `@/`; send every diagnostic to stderr. | `scripts/dxrouter.mjs` runs under bare node, where `@/` does not resolve, and must open the *same* database with the *same* driver chain and migrations rather than re-deriving a path. Diagnostics move to stderr so `dxrouter sessions --json` emits parseable stdout. |
| `src/lib/db/paths.js` (mod) | De-alias its own import of `dataDir.js`. | Same reason: it is now on the bare-node import graph, and the one data root must stay the one data root there too. |
| `package.json`, `tests/package.json` (mod) | `dxrouter` script and bin, `test:m1`. | A runnable command and a named gate. |

## Tests (all under `tests/`, vitest, groups A–I of the brief)

`continuity/prefix-hash.test.js` (C, including a child-process run for cross-process
stability) · `continuity/prefix-extension.test.js` (B) · `continuity/tokens.test.js`
(D) · `continuity/session-identity.test.js` (A) ·
`continuity/session-lifecycle.test.js` (E) ·
`continuity/session-persistence.test.js` (F) ·
`continuity/session-concurrency.test.js` (G) ·
`continuity/session-privacy.test.js` (H) ·
`continuity/session-fixtures.test.js` (§15 replay and per-fixture report) ·
`continuity/cli-sessions.test.js` (§13, including two spawned-process tests) ·
`protocol/m1-no-routing-change.test.js` (I).

Supporting material: `tests/continuity/helpers/harness.js` (a real SQLite file plus
injected clock/id/sleep), `tests/continuity/helpers/fixtures.js` (fixture loader and
replayer), and `tests/fixtures/sessions/*.json` — seven fixtures, all labelled
`synthetic`, each declaring its own provenance and expected totals. `DXR_FIXTURE_REPORT=<path>`
makes the §15 suite write the per-fixture table.

One inherited-M0 test file needed a change: `continuity/store.test.js` built its
"one step past the shipped chain" migration as a literal version `2`, which M1's `002`
made stale. It now derives that version from `CONTINUITY_SCHEMA_VERSION`.

Store tests follow the M0 pattern: a real SQLite file in a temp dir through
`createSqlJsAdapter`, asserting persisted material rather than mocks.

## Where the document and the M0 code differ (decided, not assumed)

1. **`sessions.id` is internal, not the value of the client header.** That value is
   stored separately as `client_key`. v1.1 never requires them to be equal, and
   equating them would either mutate closed sessions or collide on the primary key
   when a client reuses an id after a close.
2. **`project_root` has no wire source.** No client sends it and deriving it from
   prompt content is exactly the forbidden project-name heuristic, so it comes from
   an explicit header or is the literal `unknown`, hashed when
   `DXR_HASH_PROJECT_PATHS=1` (§14.2). Reported as a limitation.
3. **Idle timeout has no number in v1.1** (the 5 m figure there is a cache TTL).
   Default 30 min, `DXR_SESSION_IDLE_MS` override. Reported as a deviation.
4. **Explicit identity outranks lifecycle closure.** A compaction or divergence
   signal on an explicitly identified session is recorded as turn boundary metadata
   and does *not* close the session; inferred sessions close per §5. §2 says explicit
   identity must take precedence, and closing an id the client keeps sending would
   fight it every turn.
5. **No `measured` token counts are produced in M1.** M1 observes requests, not
   responses, and no tokenizer is available; the API accepts an injected tokenizer so
   `measured` is reachable and tested, but the live path labels everything
   `estimated` or `unavailable`.
6. **`open-sse/utils/sessionManager.js` is untouched.** That is a provider-facing
   upstream-cache id, unrelated to continuity sessions; a regression test pins it.
7. **`sessionInference` ships unimplemented.** The M1 deliverable is that identity is
   *resolved and persisted*; the `MILESTONE_FLAGS` entry governs the engine *acting* on
   it, which is M2 work. Leaving it unimplemented is what keeps `unimplementedRequests`
   honest: asking for it is reported at boot rather than silently granted. The
   observation path is gated by the separate top-level `sessions` flag instead.
8. **No captured agent traffic exists in this workspace.** The only genuine agent
   traffic available is a local Claude Code transcript — a client-side log, not captured
   HTTP request bytes, and out of bounds as a source for repository fixtures. So
   `scripts/derive-session-fixture.mjs` was written but never run, every shipped fixture
   is labelled `synthetic`, and the §15 captured-traffic acceptance criterion is
   reported **BLOCKED** rather than passed.
