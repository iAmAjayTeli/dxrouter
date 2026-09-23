# M0 Implementation Map

**Base:** 9Router v0.5.59 (`90b52e06`, 2026-08-29), fork-then-strangle per `FINAL-ARCHITECTURE.md` v1.1.
**Scope:** M0 — Foundation and Safety only. No M1–M6 behaviour.
**Method:** every row below was read in the working tree. Nothing here is inferred.

---

## 1. Existing code — what it actually does

### 1.1 Request path

| File | Responsibility (verified) |
|------|---------------------------|
| `src/app/api/v1/chat/completions/route.js` | Next route. `initTranslators()` once, then `handleChat(request)`. Thin. |
| `src/sse/handlers/chat.js:32` `handleChat` | Parses JSON, builds `clientRawRequest` (endpoint + body + **all headers**), extracts API key, enforces `settings.requireApiKey`, resolves combos / capacity adapter, delegates. |
| `src/sse/handlers/chat.js:161` `handleSingleModelChat` | **The real selection loop.** `while(true)` → `getProviderCredentials(provider, excludeConnectionIds, model)` → `checkAndRefreshToken` → `handleChatCore(...)` → on failure `markAccountUnavailable(...)` → `excludeConnectionIds.add(id)` → repeat. |
| `open-sse/handlers/chatCore.js:61` `handleChatCore` | Format detect → translate → token savers (rtk/headroom/caveman/ponytail/pxpipe) → `getExecutor(provider).execute({model, body, stream, credentials, signal, log, proxyOptions})` → 401/403 refresh-and-retry → streaming / non-streaming / forced-SSE-to-JSON dispatch. |
| `open-sse/translator/index.js` `translateRequest` | `(sourceFormat, targetFormat, upstreamModel, body, stream, credentials, provider, reqLogger, stripList, connectionId, clientTool)`. |
| `open-sse/executors/index.js` `getExecutor` | Registry of 30 named executors + `DefaultExecutor` fallback, cached per provider. |
| `open-sse/executors/base.js` `BaseExecutor` | `buildUrl`, `buildHeaders` (injects `Authorization: Bearer <accessToken>` / `x-api-key`), `transformRequest`, `execute`. |
| `open-sse/services/accountFallback.js` | **Pure helpers only** — `checkFallbackError`, cooldown/backoff maths, `modelLock_*` field helpers, `filterAvailableAccounts`. It has **no selection entry point**; selection lives in `chat.js` + `src/sse/services/auth.js`. |
| `src/sse/services/auth.js:28` `getProviderCredentials` | Mutex-serialised account pick: resolve alias → no-auth virtual connection → load active connections → filter excluded / model-locked / antigravity-quota-exhausted → strategy (`fill-first` default) → returns credentials, or `{allRateLimited, retryAfter, ...}`, or `null`. **Already accepts `options.preferredConnectionId`** — a pin hook that a future shadow/authoritative engine can drive without touching the walk. |
| `src/sse/services/model.js` `getModelInfo` / `getComboModels` | Model-string → `{provider, model}` via `open-sse/services/model.js` + `providers/registry`, alias table, provider-node prefixes, combo detection. |

### 1.2 Persistence

| File | Responsibility (verified) |
|------|---------------------------|
| `src/lib/dataDir.js` | `DATA_DIR` = `$DATA_DIR` (Unix-absolute paths ignored on Windows) else `%APPDATA%/9router` \| `~/.9router`. Single resolution point. |
| `src/lib/db/paths.js` | `DB_DIR = DATA_DIR/db`, `DATA_FILE = DB_DIR/data.sqlite`, `BACKUPS_DIR`, `LEGACY_FILES` (four JSON files). |
| `src/lib/db/driver.js` | `getAdapter()` singleton on `global._dbAdapter`; order Bun → `bun:sqlite`→`sql.js`, Node → `better-sqlite3`→`node:sqlite`(≥22.5)→`sql.js`. Adapter factories take a **filePath argument** (reusable for a second database). |
| `src/lib/db/adapters/*.js` | Uniform handle: `{driver, run, get, all, exec, transaction, checkpoint, close, raw}`; `PRAGMA_SQL` sets WAL + `foreign_keys=ON` + `busy_timeout`. |
| `src/lib/db/migrate.js` | `runMigrationOnce(adapter)`: freshness probe → prune backups → `backupDbLite` when `backupSchemaVersion < SCHEMA_VERSION` → numbered `MIGRATIONS` each in its own transaction → additive `syncSchemaFromTables` → one-time legacy-JSON import with `importWithAssertion` row-count equality and `MigrationAborted` rollback. **Pattern to mirror, not to extend.** |
| `src/lib/db/repos/connectionsRepo.js` | Provider credentials. Non-column fields (`accessToken`, `refreshToken`, `idToken`, `apiKey`, `providerSpecificData`, …) are `JSON.stringify`-ed into `providerConnections.data` — **plaintext**. |
| `src/lib/db/repos/requestDetailsRepo.js` | Buffered writer for request/response detail. `enableObservability` default **false**, `ENABLE_REQUEST_LOGS` env overrides. `sanitizeHeaders` deletes `authorization`/`x-api-key`/`cookie`/`token`/`api-key` but **only on `item.request.headers`**, and only on the persisted path. |
| `src/lib/db/repos/settingsRepo.js` | `DEFAULT_SETTINGS`: `requireLogin: true`, `requireApiKey: true`, `enableObservability: false`. |
| `src/lib/db/repos/apiKeysRepo.js` | `apiKeys.key` stored plaintext; `validateApiKey(key)` exact match + `isActive`. |
| `src/lib/usageDb.js`, `src/lib/localDb.js`, `src/lib/requestDetailsDb.js` | Thin re-export shims over `@/lib/db/index.js`. |

### 1.3 Auth / exposure / diagnostics

| File | Responsibility (verified) |
|------|---------------------------|
| `src/dashboardGuard.js` `proxy()` | The single gate. `LOCAL_ONLY_PATHS` → CLI token or (loopback + auth). `ALWAYS_PROTECTED` → JWT/CLI token. `PUBLIC_PREFIXES = ["/v1","/v1beta","/api/v1","/api/v1beta","/codex"]` → `canAccessPublicLlmApi` = **`isLocalRequest(request)` OR CLI token OR valid API key**. `/api/*` deny-by-default with a public allow-list. `/dashboard/*` → JWT unless `requireLogin === false`. |
| `src/lib/auth/dashboardSession.js` | HS256 JWT (24 h) with secret from `$JWT_SECRET` or `DATA_DIR/jwt-secret` (generated, `0600`). `DEFAULT_PASSWORD = "123456"` at line 9; `verifyDashboardPassword` accepts it when no hash is stored. |
| `src/app/api/auth/login/route.js` | Login + IP lockout. `initialPassword = $INITIAL_PASSWORD \|\| "123456"` (line 58). Partial guard at line 68: default password + non-local peer → 403 `mustChangePassword`, **no** token issued. Local fresh install still logs in with `123456`. |
| `cli/cli.js:96` | `DEFAULT_HOST = "0.0.0.0"` — binds all interfaces by default; only prints a yellow warning (line 603). |
| `custom-server.js` | Wraps `http.createServer`: stamps unspoofable `x-9r-real-ip` + per-process `x-9r-peer-token`, strips client-supplied forwarding headers, h2c downgrade. Does not choose the bind address (`HOSTNAME` from the CLI env). |
| `src/instrumentation.js` `register()` | Node-runtime startup hook: console-log capture, catalog source, catalog sync. **The place for the M0 security bootstrap.** |
| `open-sse/utils/requestLogger.js` | Off unless `ENABLE_REQUEST_LOGS=true`. Writes per-request JSON to **`process.cwd()/logs/`**. `maskSensitiveHeaders` (line 72) is commented out — *"DISABLED - keep full token for testing"* — so it persists client **and upstream** `Authorization` verbatim. |
| `src/app/api/translator/{save,load}/route.js`, `open-sse/transformer/responsesTransformer.js` | Also write under `process.cwd()/logs/`. |

---

## 2. Spec-vs-reality deltas (reported, not silently "fixed")

| `FINAL-ARCHITECTURE.md` §13.1 row | Reality in v0.5.59 | Action |
|---|---|---|
| "`REQUIRE_API_KEY=false` default" | **No such env var exists** (zero hits in `src`, `open-sse`, `custom-server.js`). The real flag is `settings.requireApiKey`, default **`true`**. | Row is wrong. Real gap is narrower: the `isLocalRequest` bypass in `canAccessPublicLlmApi`. Fix that; correct the spec row in the M0 report. |
| "`usageDb` hardcoded `~/.9router/usage.json`, ignores `DATA_DIR`" | Already fixed upstream — `usageDb.js` is a shim over the `DATA_DIR`-derived SQLite layer. | Nothing to fix. Report as already-resolved. |
| "request bodies persisted by default" | `enableObservability` defaults to **false**. | Already correct upstream. Keep it off, and add the redaction/root fixes that are genuinely missing. |
| "binds all interfaces" | **Confirmed** (`cli/cli.js:96`). | Fix. |
| "plaintext credentials at rest" | **Confirmed** (`providerConnections.data`). The provider-add UI even claims "will be encrypted and stored securely" — currently false. | Fix. |
| "default password `123456`" | **Confirmed** in 3 code sites; remote use partially blocked already. | Fix. |
| *(not in spec — found during mapping)* | `maskSensitiveHeaders` disabled → upstream provider bearer tokens written to a **repo-relative** `logs/` dir when request logging is on. | Fix; add to the §13.1 list. |

---

## 3. M0 changes — file → responsibility → change reason

### 3.1 Security (lands first)

| File | Responsibility | Change reason |
|---|---|---|
| `src/lib/security/redact.js` *(new)* | `redactSecrets(value)` deep-walk; `REDACTED` sentinel; key set = authorization, api keys, cookies, tokens, passwords, client secrets. | One unconditional redactor so no diagnostic writer can opt out (§14). |
| `src/lib/security/crypto.js` *(new)* | AES-256-GCM `encryptSecret`/`decryptSecret`, `dxr1:` envelope, idempotent, decrypt failure → `null` + warning. | Credentials encrypted at rest (§13.1) without making an unreadable key a boot failure. |
| `src/lib/security/masterKey.js` *(new)* | Key chain: `DXR_MASTER_KEY` → OS keychain (Windows DPAPI-wrapped keyfile, macOS `security`, Linux `secret-tool`) → refuse unless `DXR_KEY_STORE=file`. | "Key from OS keychain or `DXR_MASTER_KEY`; refuse to start if credentials cannot be securely protected." No new native dependency. |
| `src/lib/security/bootstrapCredential.js` *(new)* | First run with no stored hash → generate 26-char random, store bcrypt hash, emit once to stdout + `DATA_DIR/initial-credential.txt` (`0600`), delete on first successful login. | "No default password; first run generates a secure random credential; credential shown once." |
| `src/lib/security/networkExposure.js` *(new)* | Classify `HOSTNAME`; non-loopback requires `DXR_ALLOW_NETWORK=1` **and** `requireLogin !== false` **and** `requireApiKey !== false`; otherwise refuse to start. | "Network exposure requires explicit opt-in **and** authentication; refuse unsafe `0.0.0.0`." |
| `src/lib/security/bootstrap.js` *(new)* | Ordered startup: resolve data root → log root (no secrets) → master key → credential bootstrap → exposure check → flag banner. | Single ordered entry point so a failure refuses the boot instead of degrading silently. |
| `src/instrumentation.js` | Call the bootstrap first in `register()`. | Only Node-runtime startup hook the app already owns. |
| `src/app/api/auth/login/route.js` | Delete the `"123456"` fallback; accept only the stored hash or an explicit `INITIAL_PASSWORD`. | No default password. |
| `src/lib/auth/dashboardSession.js` | Delete `DEFAULT_PASSWORD`; `verifyDashboardPassword` requires a stored hash or explicit `INITIAL_PASSWORD`. | Same, second code path. |
| `cli/src/cli/menus/settings.js` | "Reset password to default" → reset to a **freshly generated** random credential, shown once. | Removes the last route back to a public default. |
| `src/dashboardGuard.js` | `canAccessPublicLlmApi`: drop the blanket `isLocalRequest` bypass — loopback must present a valid API key or the machine CLI token. `isAuthenticated`: honour `requireLogin === false` for loopback only. | "Localhost still requires authentication"; closes the whole-API-surface local bypass. |
| `cli/cli.js` | `DEFAULT_HOST = "127.0.0.1"`; non-loopback `--host` requires `DXR_ALLOW_NETWORK=1`, else exit with an explanation. | Network exposure is opt-in. |
| `src/lib/db/repos/connectionsRepo.js` | Encrypt/decrypt the sensitive field set around the `data` JSON column. | Provider credentials encrypted at rest. |
| `src/lib/db/migrations/002-encrypt-credentials.js` *(new)* + `migrations/index.js` + `schema.js` `SCHEMA_VERSION` | One-time encryption of existing rows through the upstream runner (transaction + pre-change backup). | Existing installs must not stay plaintext; also exercises the inherited migration/backup path M0 must prove. |
| `src/lib/db/repos/requestDetailsRepo.js` | Replace `sanitizeHeaders` with the shared `redactSecrets` over the **whole** persisted record. | Redaction must be unconditional and not limited to one header bag. |
| `open-sse/utils/requestLogger.js` | Re-enable masking as hard redaction, unconditional; move `LOGS_DIR` to `DATA_DIR/logs`. | Stops writing upstream bearer tokens; removes a repo-relative store. |
| `src/app/api/translator/{save,load}/route.js`, `open-sse/transformer/responsesTransformer.js` | Point at `DATA_DIR/logs/translator`. | Single data root. |
| `src/app/api/translator/save/route.js` | Also scrub the trace through `redactString` before writing it. | An inspector trace is a diagnostic written to disk; redaction has no off switch. |
| `src/lib/consoleLogBuffer.js` | Scrub every buffered line on the way in (the operator's own terminal copy is untouched). | The buffer is retained in memory, streamed to the dashboard log viewer and served by `/api/logs` — a diagnostic writer, so it redacts. |
| `src/app/login/page.js` | Replace the "default password is 123456" hint with where the generated credential is printed/written. | The hint was the default password's last advertisement. |
| `src/app/api/auth/reset-password/route.js` | Return a freshly generated credential instead of resetting to a literal. | Backs the CLI reset path; no route back to a known default. |
| `src/lib/db/helpers/credentialCrypto.js` *(new)* | `ENCRYPTED_FIELDS`, `encryptConnectionSecrets` / `decryptConnectionSecrets` / `hasPlaintextSecret` — field-level envelope over the connection blob, idempotent both ways. | One place decides which fields are secret, so the repo, the migration and import/export cannot disagree. |
| `src/lib/db/index.js`, `repos/settingsRepo.js` | Encrypt on `importDb`, keep envelopes on `exportDb`; settings read path used by the bootstrap. | A plaintext export or import would defeat encryption at rest. |

### 3.2 Data root

| File | Responsibility | Change reason |
|---|---|---|
| `src/lib/dataDir.js` | Precedence `DXR_DATA_DIR` → `DATA_DIR` (deprecation warning) → platform default; export `DATA_DIR_SOURCE`. | One configured root, `DXR_DATA_DIR` authoritative, existing installs keep their directory name so no data is orphaned. |
| `src/lib/appUpdater.js`, `src/lib/mitmAliasCache.js` | Import `DATA_DIR` instead of re-deriving `~/.9router`. | These looked for the mitm PID file and the alias cache in a directory a `DXR_DATA_DIR` install never writes. |
| `src/mitm/paths.js`, `src/lib/updater/updater.js` | Keep their own copy of the precedence, documented as such. | Both run outside the bundler (spawned scripts), so they cannot import `@/lib/dataDir`; they were the only two permitted duplicators and `tests/security/data-root.test.js` asserts they stay in step. **Since superseded:** `src/lib/updater/updater.js` was deleted with the self-install path, so `src/mitm/paths.js` is now the only duplicator. |
| `src/lib/tunnel/tailscale/tailscale.js` | `--statedir` under the configured root (comment corrected). | Tailscale state is app data. |
| `cli/hooks/sqliteRuntime.js`, `cli/src/cli/api/client.js` | Add `DXR_DATA_DIR` ahead of `DATA_DIR` in their resolvers. | The CLI must never resolve a different root than the server; the SQLite runtime cache and the CLI token live under the same root. |
| `cli/cli.js` | `getAppDataDir()` gains the same precedence; the crash-recovery path reads `<data root>/db.json` instead of a hardcoded home path. | Same reason. |

### 3.3 Continuity store (own database in the one data root)

| File | Responsibility | Change reason |
|---|---|---|
| `continuity/store/sqlite/schema.js` *(new)* | §12 tables as SQL text, including v0.2–v0.4 tables left empty; money columns `INTEGER` micro-USD. | Schema is continuity's own contract; future tables may exist unpopulated. |
| `continuity/store/sqlite/migrations/001-initial.js`, `migrations/index.js` *(new)* | Forward-only numbered migrations, `up(db)` only. | No ORM, no destructive automatic migration. |
| `continuity/store/sqlite/migrate.js` *(new)* | Applies pending versions inside a transaction, records `schema_version` in `_meta`, refuses to run backwards. | Deterministic fresh-install and upgrade behaviour. |
| `continuity/store/index.js` *(new)* | `openContinuityStore(db)` — takes an **injected** port-shaped handle. Zero imports outside `continuity/`. | I1: continuity cannot import `src/**`, so it cannot open a file itself. |
| `adapters/ninerouter/continuityDb.js` *(new)* | Builds the handle from `src/lib/db/adapters/*` at `DATA_DIR/db/continuity.sqlite`, WAL, file-copy pre-migration backup into `DATA_DIR/db/backups/`. | The adapter layer is the only bilingual layer; reuses the proven driver chain instead of duplicating it. |

### 3.4 Ports (`continuity/ports/`, new)

| File | Responsibility | Change reason |
|---|---|---|
| `normalizedRequest.js` | `NormalizedRequest` shape + `assertNormalizedRequest`. | Continuity must never see Next/Express/provider request objects. |
| `routeExecutor.js` | `execute(route, request, signal) → ExecutionResult`. | Provider execution stays behind an interface. |
| `credentialStore.js` | `list/get/markUnavailable/clearError`, opaque handles — **no secret material crosses the port**. | Continuity never handles credentials. |
| `catalog.js` | `resolveModel`, `listRoutes`, `pricingFor`. | Model/pricing knowledge injected, not imported. |
| `clock.js` | `nowMs()` integer UTC, `systemClock`, `fixedClock`. | I6 purity + canonical integer-ms serialisation. |
| `index.js` | Re-exports. | Single import surface for adapters. |

### 3.5 Adapters (`adapters/ninerouter/`, new)

| File | Responsibility | Change reason |
|---|---|---|
| `normalizeAdapter.js` | Next `Request` + parsed body → `NormalizedRequest`. | Translation boundary. |
| `executorAdapter.js` | `RouteExecutor` over `getExecutor(provider).execute(...)`. | Reuses upstream execution unchanged. |
| `credentialAdapter.js` | `CredentialStore` over `connectionsRepo` + `markAccountUnavailable`/`clearAccountError`, exposing handles only. | Keeps secrets out of continuity. |
| `catalogAdapter.js` | `Catalog` over `src/sse/services/model.js` + `pricingRepo`. | Same. |
| `clockAdapter.js` | `systemClock` re-export. | Injection point for tests. |
| `legacySelectionAdapter.js` | Records what the legacy walk chose (`getProviderCredentials` + exclude-set) in the port's vocabulary. **Not wired into the request path in M0.** | Future shadow mode needs a comparable legacy decision; `accountFallback` stays authoritative. |

### 3.6 Boundary enforcement, flags, tests, docs

| File | Responsibility | Change reason |
|---|---|---|
| `scripts/check-import-boundary.mjs` *(new)* | Static scan of `continuity/**` import/require specifiers; allow relative-within-continuity + a node-builtin allow-list; non-zero exit + precise message otherwise. | I1 must be mechanical, not review-based. |
| `package.json` | `lint:boundary`, `test:m0` scripts. | Locally runnable, deterministic. |
| `.github/workflows/ci.yml` *(new)* | Runs the boundary check and the test suites. | "CI must fail if any such import appears." |
| `continuity/flags.js` *(new)* | Pure `resolveFlags(env)`: `DXR_ENGINE=off`, `DXR_ENGINE_AUTHORITY=off`, `DXR_SHADOW=off`, `DXR_ALLOW_NETWORK=0`. | Later milestones need a switch that is off in M0. |
| `src/lib/dxr/flags.js` *(new)* | `resolveFlags(process.env)` for the app side. | Keeps `continuity/` free of `process`. |
| `tests/security/*.test.js` *(new)* | Redaction, encryption-at-rest against **actually persisted rows**, no-default-password, guard defaults, exposure refusal. | "Tests must inspect actual persisted material." |
| `tests/continuity/*.test.js` *(new)* | Store migration from fresh + idempotent re-run + backup, ports contracts, adapters, import boundary (good fixture passes / bad fixture fails). | M0 acceptance items 5–10. |
| `tests/protocol/upstream-compat.test.js` *(new)* | §19.1a: OpenAI / Anthropic / Gemini / Responses / Ollama routes, SSE framing, executor URL+headers, translator round-trips, error shapes — asserted against the pre-change behaviour, alongside the existing `tests/translator/**` goldens. | Proves upstream compatibility except the documented security changes. |
| `tests/protocol/credential-path.test.js` *(new)* | Store a connection, then assert the raw column holds an envelope, `getProviderCredentials` hands back the plaintext, and `DefaultExecutor.buildHeaders` puts the real key on the wire while `redactHeaders` masks it. | Encryption at rest must not silently break the one path that matters: the credential reaching the upstream provider. |
| `tests/unit/local-request-peer-trust-3294.test.js`, `tests/unit/dashboard-guard.test.js`, `tests/unit/request-details-tab.test.js` | Upstream tests re-aligned to the new defaults (loopback presents a credential; observability and bodies switched on explicitly), each with a comment naming the intentional change. | "Where M0 intentionally changes upstream behavior, document the change" — the tests are where it would otherwise look like a regression. |
| `.env.example` | Rewritten: required vars, M0 security block, milestone flags marked unimplemented, test seams. | The env contract is the operator-facing half of the security defaults. |
| `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md`, `docker-compose.yml` | Remove the `123456` default from the env tables and troubleshooting; document `DXR_DATA_DIR` / `DXR_MASTER_KEY` / `DXR_ALLOW_NETWORK`; docker examples publish on `127.0.0.1` and pass the exposure opt-in. | The documented deployment paths would otherwise refuse to start, and the docs advertised a password that no longer exists. |
| `CLAUDE.md`, `docs/`, `README*` password lines | Document new defaults, first-run credential, `DXR_DATA_DIR`, exposure rules, boundary rule, how to run M0 tests. | Documented intentional divergence from upstream. |

---

## 4. Deviations from `FINAL-ARCHITECTURE.md` v1.1

1. **Continuity store file.** §12 implies `data/dxrouter.db`. M0 uses `DATA_DIR/db/continuity.sqlite` — a separate database inside the one configured data root. Sharing upstream's `data.sqlite` would force `continuity/**` to import `src/lib/db/`, breaching I1. The requirement satisfied is the real one: a single configured data root.
2. **§13.1 fix list is corrected, not just executed** — see §2 above (`REQUIRE_API_KEY` does not exist; `usageDb` path already fixed; observability already off). One new weakness is added to the list (disabled header masking writing upstream tokens to a repo-relative `logs/`).
3. **App directory name stays `9router`** (`%APPDATA%/9router`, `~/.9router`) unless `DXR_DATA_DIR` is set. Renaming it would orphan every existing install's credentials and usage history.
4. **Repository provisioning.** The upstream fork was not present in the working tree at the start of M0; it was cloned to the project root (v0.5.59) as the prerequisite the instruction assumed.

## 5. Explicitly out of scope in M0

No `SessionResolver`, no session persistence read or written by requests, no cache ledger or cache-cost maths, no candidate ranking, no task-boundary detection, no shadow comparison, no compatibility probes, no STAY/MOVE/WAIT, no Session Rebase, no Drift Sentinel, no new providers. `DXR_ENGINE` stays `off`; the legacy walk in `src/sse/handlers/chat.js` remains authoritative.
