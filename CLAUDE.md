# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), `continuity/` + `adapters/ninerouter/` (the DXRouter continuity engine and its 9Router adapters — see "M0" below), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).
- `npm run lint:boundary` — enforces I1 (nothing under `continuity/` may import 9Router). Dependency-free, also run standalone in CI.
- `npm run test:m0` — the M0 suites only (`tests/security/`, `tests/continuity/`, `tests/protocol/`); these are expected to be **all green**.
- First start prints a generated dashboard credential once. See "M0 security defaults" below before wondering why login rejects `123456`.

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** As of M0: 2433 tests, ~2287 pass, ~87 fail. The M0 suites (`security/`, `continuity/`, `protocol/` — 346 tests) are green; every remaining failure is inherited and outside M0's footprint. Expected red:
> - `tests/__baseline__/known-fails.txt` catalogues the ones upstream shipped red (oauth-cursor-auto-import, translator-request-normalization, …). The committed baselines are **stale** — snapshotted at 674–840 tests on a `/Users/…/app` checkout — so `verify-no-regression.mjs` reports every newer inherited failure as a regression and its path normalisation (`split("/app/")`) does not work off that machine. Judge a change by re-running the files it touches, not by that gate.
> - `unit/cursor-agent-proto.test.js` (35) needs `protobufjs`; `unit/request-details-tab.test.js` (1, the `backupDbLite` case) needs the `better-sqlite3` native binding. Both are optional deps.
> - `unit/security-audit.test.js` (13) reads source with `path.resolve("src/…")`, i.e. relative to the **cwd**, so it only passes when vitest runs from the repo root.
> - Network-dependent: `codex-image-fetch`, `image-fetch-hardening`, `cursor-models`, `mimo-free.live`.
> - Windows-specific: `headroom-detect` (path separators), `compatible-provider-connections` / `model-routing` (EPERM in `rmSync` teardown — Windows holds the SQLite handle).
> - Inherited translator/executor drift against committed goldens: `golden-request` (kiro `agentMode`), `bugs-toClaude-context`, `combo-autoswitch`, `windsurf-executor`, `executor-const-guard`, `force-stream-config`, `kiro-terminal-integrity`, `openai-to-claude`, `translator-helpers-edge`, `claude-header-forwarding`, `db-concurrent` (count loss under the `node:sqlite` fallback driver).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js`, which defers to `src/lib/dataDir.js` — see "One data root" below. Usage and request logs are rows in that same SQLite file; `src/lib/usageDb.js` is a shim over the repos. `usage.json` / `db.json` survive only as `LEGACY_FILES` one-time import sources, resolved inside the configured root like everything else.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `DXR_MASTER_KEY` (credential encryption), `INITIAL_PASSWORD` (optional — there is no default password any more), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example`; ARCHITECTURE.md's env matrix predates M0.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).

## M0 — Foundation and Safety (implemented)

M0 is the first milestone of the DXRouter strangler-fig migration described in `FINAL-ARCHITECTURE.md` (the source of truth) and mapped file-by-file in `M0-IMPLEMENTATION-MAP.md`. It adds security, one data root and the continuity boundary. **It deliberately changes nothing about routing:** the continuity engine ships OFF and `accountFallback` remains authoritative.

### M0 security defaults
Implemented in `src/lib/security/` and wired from `src/instrumentation.js`. Five ordered bootstrap steps, memoised on `global._dxrSecurityBootstrap`: data root → master key → dashboard credential → network exposure → flags. A step that cannot be satisfied **refuses to start** (`SecurityBootstrapError`, then `process.exit(1)`); `DXR_BOOTSTRAP_NO_EXIT=1` turns the exit into a throw for tests.

- **No default password.** First run with no stored hash generates a random credential, prints it once, and writes `<data root>/initial-credential.txt` (0600), deleted on first successful login. `INITIAL_PASSWORD` still provisions a known one.
- **Loopback is not a credential.** Authentication is required from `127.0.0.1` too. Both operator opt-outs (`requireApiKey: false`, `requireLogin: false`) are loopback-scoped and ignored for remote callers; unreadable settings mean "authentication required".
- **Network exposure is opt-in.** `src/lib/security/networkExposure.js` classifies the bind host; a non-loopback bind needs `DXR_ALLOW_NETWORK=1` *and* authentication left on. Wildcard binds (`0.0.0.0`, `::`) are refused outright.
- **Credentials encrypted at rest.** AES-256-GCM under a `dxr1:` envelope (`src/lib/security/crypto.js`), applied per field by `src/lib/db/helpers/credentialCrypto.js`. Key: `DXR_MASTER_KEY` → OS keychain (DPAPI / `security` / `secret-tool`) → refuse, unless `DXR_KEY_STORE=file`. Decryption failure returns `null` rather than throwing, so one unreadable row costs one re-authentication, not the process. Migration `002-encrypt-credentials` encrypts existing rows in place and is idempotent.
- **Diagnostics off by default, redaction unconditional.** `enableObservability` and `persistRequestBodies` are two independent switches, both default `false`. `src/lib/security/redact.js` has no disable flag; every diagnostic writer routes through it. Persisted rows use `drop: true` (the key is absent, not masked).

### One data root
`src/lib/dataDir.js` is the only resolver: `DXR_DATA_DIR` → `DATA_DIR` (deprecated, warns) → platform default. Everything derives from it — db, logs, backups, MITM state, tailscale state, keyfile, credential file. `tests/security/data-root.test.js` scans `src/`, `open-sse/` and `continuity/` for any module deriving its own root and fails if one appears. Exactly two files may duplicate the precedence, because they cannot import the alias: `src/mitm/paths.js` (CommonJS child process) and `dataDir.js` itself. Each must say `DXR_DATA_DIR` and "kept in step".

### The continuity boundary (I1)
`continuity/` is the new engine. It may import only its own tree and `node:` builtins — never `open-sse`, `@/`, `next/`, or a relative path that escapes upward. `scripts/check-import-boundary.mjs` enforces this (static imports, `require()`, dynamic `import()`, ignoring comments) and CI runs it as its own job. To let the engine see something new, widen a port in `continuity/ports/` and implement it in the adapters — do not add an import.

The five ports are `NormalizedRequest`, `RouteExecutor`, `CredentialStore`, `Catalog`, `Clock`, all under `continuity/ports/`. The 9Router implementations live **outside** that tree in `adapters/ninerouter/` — that is the only place allowed to import both sides, which is why the boundary check runs against `continuity/` alone. `legacySelectionAdapter.js` wraps `accountFallback` for a future shadow mode; nothing calls it from the live request path in M0. Continuity state is its own `<data root>/db/continuity.sqlite`, separate from `data.sqlite`. Milestone flags (`continuity/flags.js`) all resolve `false` in M0 and a requested-but-unimplemented flag is reported at boot rather than silently ignored.

### Intentional upstream behaviour changes (M0)
Byte-identical behaviour is **not** claimed. These differ on purpose:
1. Login no longer accepts `123456`; `PATCH /api/settings` no longer accepts it either.
2. Loopback callers must authenticate. Three tests in `tests/unit/dashboard-guard.test.js` and seven in `tests/unit/local-request-peer-trust-3294.test.js` were updated to assert the new default plus the loopback-only opt-out.
3. Observability is opt-in and request bodies are a second opt-in. `tests/unit/request-details-tab.test.js` now enables both explicitly.
4. Provider credentials are encrypted on import and stay enveloped on export.
5. `src/lib/appUpdater.js` and `src/lib/mitmAliasCache.js` used to re-derive `~/.9router`; both now use the configured root, as does `src/mitm/paths.js`. (`src/lib/updater/updater.js` was the fourth; it has since been deleted with the self-install path.)
6. A non-loopback or wildcard bind that used to start silently now refuses.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
