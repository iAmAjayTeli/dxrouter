/**
 * Continuity store schema — plain SQL text, no ORM.
 *
 * Every statement here is `IF NOT EXISTS`, so applying the DDL twice is a no-op;
 * migration 001 owns it and the version stamp in `_meta` is what actually gates
 * re-application (see migrate.js).
 *
 * Two rules from the architecture that are easy to break later and expensive to
 * discover:
 *  - Every monetary column is INTEGER micro-USD (`_uusd`). No REAL anywhere: a
 *    float round-trip through SQLite would make the canonical decision hash
 *    irreproducible, and the hash is the trace.
 *  - Tables for later milestones (contracts, fixtures, experiments, canary_runs,
 *    handoffs, bodies) are created empty in M0 on purpose. Their existence is NOT
 *    permission to implement the behaviour behind them.
 *
 * This module is pure data. It imports nothing — not even from elsewhere in
 * `continuity/` — so it can be read by a test, a migration, or a doc generator.
 */

/** Bumped only by adding a migration file; see migrations/index.js. */
export const CONTINUITY_SCHEMA_VERSION = 5;

/** Applied on every open, before any migration. */
export const PRAGMA_STATEMENTS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA temp_store = MEMORY",
];

/** Version/marker table. Deliberately the same shape as the inherited `_meta`. */
export const META_DDL = `
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** §12 core tables — the ones v0.1 writes to. */
export const CORE_DDL = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_root TEXT NOT NULL,
    identity_confidence TEXT NOT NULL,
    identity_source TEXT NOT NULL,
    pin_provider TEXT,
    pin_model TEXT,
    pinned_at INTEGER,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT,
    lock_owner TEXT,
    lock_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(closed_at) WHERE closed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_root, opened_at)`,

  `CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    at INTEGER NOT NULL,
    tools_hash TEXT,
    system_hash TEXT,
    messages_hash TEXT,
    tools_tokens INTEGER,
    system_tokens INTEGER,
    messages_tokens INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    PRIMARY KEY (session_id, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS cache_entries (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prefix_hash TEXT NOT NULL,
    layer TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    written_at INTEGER NOT NULL,
    ttl_s INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    PRIMARY KEY (provider, model, prefix_hash, layer)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_cache_expiry ON cache_entries(written_at)`,

  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_idx INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    outcome_authority TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    arithmetic_json TEXT NOT NULL,
    provenance TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    canon_version TEXT NOT NULL,
    decision_hash TEXT NOT NULL,
    policy_version TEXT,
    catalog_version TEXT,
    cache_model_version TEXT,
    engine_version TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_decisions_session ON decisions(session_id, turn_idx)`,
  `CREATE INDEX IF NOT EXISTS ix_decisions_created ON decisions(created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_decisions_hash ON decisions(decision_hash)`,

  `CREATE TABLE IF NOT EXISTS candidates (
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    rank INTEGER,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    eligible INTEGER NOT NULL,
    elimination_reason TEXT,
    stay_cost_uusd INTEGER,
    move_cost_uusd INTEGER,
    return_cost_uusd INTEGER,
    delta_uusd INTEGER,
    cost_provenance TEXT NOT NULL,
    PRIMARY KEY (decision_id, provider, model)
  )`,

  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    http_status INTEGER,
    error_class TEXT,
    retry_after_s INTEGER,
    reported_model TEXT,
    usage_in INTEGER,
    usage_out INTEGER,
    usage_cache_read INTEGER,
    usage_cache_write INTEGER,
    ttfb_ms INTEGER,
    total_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_attempts_decision ON attempts(decision_id, seq)`,

  `CREATE TABLE IF NOT EXISTS divergences (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    class TEXT NOT NULL,
    engine_json TEXT NOT NULL,
    legacy_json TEXT NOT NULL,
    cost_delta_uusd INTEGER,
    cost_delta_provenance TEXT NOT NULL,
    explained_by TEXT,
    explained_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS ix_div_class ON divergences(class, explained_at)`,
];

/**
 * Tables that exist from M0 but stay empty until the milestone that owns them.
 * Listed separately so a test can assert "present and empty" without hardcoding
 * the whole schema, and so nobody mistakes them for v0.1 surface.
 */
export const FUTURE_DDL = [
  // v0.2 — compatibility contracts
  `CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    provider TEXT,
    model TEXT,
    probe_suite_version TEXT,
    results_json TEXT,
    verified_at INTEGER,
    stale_after INTEGER
  )`,
  // §19.3 replay gate
  `CREATE TABLE IF NOT EXISTS fixtures (
    id TEXT PRIMARY KEY,
    label TEXT,
    project_kind TEXT,
    turns INTEGER,
    recorded_at INTEGER,
    bodies_included INTEGER NOT NULL DEFAULT 0
  )`,
  // §19.4 evidence harness
  `CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    measure TEXT NOT NULL,
    ran_at INTEGER NOT NULL,
    harness_version TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    n INTEGER NOT NULL,
    verdict TEXT,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    unblocks TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ix_experiments_q ON experiments(question, ran_at)`,
  // v0.4 — drift sentinel
  `CREATE TABLE IF NOT EXISTS canary_runs (
    id TEXT PRIMARY KEY,
    provider TEXT,
    model TEXT,
    corpus_version TEXT,
    ran_at INTEGER,
    metrics_json TEXT,
    control_window_id TEXT
  )`,
  // v0.3 — session rebase
  `CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    compiled_at INTEGER,
    compiled_by_provider TEXT,
    compiled_by_model TEXT,
    speculative INTEGER NOT NULL,
    validation_status TEXT,
    destination_contract_id TEXT,
    artifact_ref TEXT
  )`,
  // Opt-in body capture, content-addressed (§14.1)
  `CREATE TABLE IF NOT EXISTS bodies (
    hash TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    first_seen INTEGER NOT NULL,
    project_root TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

/** Tables v0.1 writes to. */
export const CORE_TABLES = [
  "sessions",
  "turns",
  "cache_entries",
  "decisions",
  "candidates",
  "attempts",
  "divergences",
];

/** Tables created empty in M0 for a later milestone. */
export const FUTURE_TABLES = [
  "contracts",
  "fixtures",
  "experiments",
  "canary_runs",
  "handoffs",
  "bodies",
];

/** Every table the store owns, `_meta` included. */
export const ALL_TABLES = ["_meta", ...CORE_TABLES, ...FUTURE_TABLES, "session_prefix", "turn_results"];

/** Money columns, per table. Asserted by test to stay INTEGER. */
export const MICRO_USD_COLUMNS = {
  candidates: ["stay_cost_uusd", "move_cost_uusd", "return_cost_uusd", "delta_uusd"],
  divergences: ["cost_delta_uusd"],
};

/* ------------------------------------------------------------------------- *
 * M1 additions (schema version 2). Migration 002 owns these.
 *
 * They are declared here, beside the 001 text, so the whole schema is still
 * readable in one file — but 001's body above is released and must not be edited,
 * so M1 arrives as ALTER TABLE ADD COLUMN plus one new table.
 *
 * Every added column is nullable or carries a DEFAULT, which is what makes the
 * migration forward-only and non-destructive: an existing row stays valid, and no
 * data is rewritten or dropped.
 * ------------------------------------------------------------------------- */

/**
 * Columns added to `sessions`. `[name, ddl]` pairs so the migration can add only
 * what is missing and a test can assert the set without parsing SQL.
 */
export const M1_SESSION_COLUMNS = [
  // The validated client-supplied key, kept separate from `id`. `id` is internal so
  // that a client reusing its key after a close cannot collide on the primary key.
  ["client_key", "TEXT"],
  // Lineage only. Deliberately no foreign key: retention may delete the predecessor
  // long before the successor, and losing lineage must not delete a live session.
  ["predecessor_id", "TEXT"],
  ["state", "TEXT NOT NULL DEFAULT 'active'"],
  ["last_seen_at", "INTEGER"],
  ["turn_count", "INTEGER NOT NULL DEFAULT 0"],
  // 1 when project_root holds a `pr1:` hash rather than a path (DXR_HASH_PROJECT_PATHS).
  ["project_root_hashed", "INTEGER NOT NULL DEFAULT 0"],
];

/** Columns added to `turns` — §10's per-turn record. Never a request body. */
export const M1_TURN_COLUMNS = [
  ["identity_confidence", "TEXT"],
  ["identity_source", "TEXT"],
  ["message_count", "INTEGER"],
  ["tools_tokens_provenance", "TEXT"],
  ["system_tokens_provenance", "TEXT"],
  ["messages_tokens_provenance", "TEXT"],
  ["token_estimator", "TEXT"],
  // Prefix relation to the previous turn of this session, and where it broke.
  ["relation", "TEXT"],
  ["divergence_index", "INTEGER"],
  ["invalidated_layers", "TEXT"],
  ["boundary", "TEXT"],
  ["labels", "TEXT"],
  ["notes", "TEXT"],
  // Non-body request metadata, useful for inspection and forbidden from carrying
  // content: the wire protocol name and the model string the client asked for.
  ["protocol", "TEXT"],
  ["requested_model", "TEXT"],
];

/**
 * Latest prefix state, exactly one row per session.
 *
 * One row per session rather than per turn, because the prefix-extension check only
 * ever needs the most recently observed state, and keeping per-message digests in
 * `turns` would turn an append-only log into the biggest object in the database.
 *
 * `digests_json` holds the per-message digests of the observed sequence, capped at
 * the policy's `maxChainMessages` and truncated from the tail (the opening messages
 * are the ones a divergence index is measured against). `digests_truncated` records
 * that the cap bit, so a null divergence index can be told apart from an absent one.
 * The proof of extension itself never needs this column — it is computed from the
 * incoming request's own rolling chain against `messages_hash` and `message_count` —
 * so a truncated row still resolves identity at full strength.
 */
export const SESSION_PREFIX_DDL = `
CREATE TABLE IF NOT EXISTS session_prefix (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  turn_idx INTEGER NOT NULL,
  tools_hash TEXT,
  system_hash TEXT,
  messages_hash TEXT,
  message_count INTEGER,
  tools_tokens INTEGER,
  system_tokens INTEGER,
  messages_tokens INTEGER,
  digests_json TEXT,
  digests_truncated INTEGER NOT NULL DEFAULT 0
)`;

/** Indices M1 needs. Candidate lookup is (tools_hash, system_hash) over open sessions. */
export const M1_INDICES = [
  `CREATE INDEX IF NOT EXISTS ix_session_prefix_layers ON session_prefix(tools_hash, system_hash)`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_client_key ON sessions(client_key, opened_at)`,
  `CREATE INDEX IF NOT EXISTS ix_sessions_last_seen ON sessions(last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS ix_turns_at ON turns(at)`,
];

/** Tables introduced by M1. */
export const M1_TABLES = ["session_prefix"];


/* ------------------------------------------------------------------------- *
 * M2 additions (schema version 3). Migration 003 owns these.
 *
 * M2 records what is *believed* about an upstream prompt cache and what a provider
 * *reported* about it. Two rules shape the columns below:
 *
 *  - No money. Cache economics enter a decision in M3, so there is deliberately no
 *    `_uusd` column here: a cost column would invite an M2 write that I3 forbids
 *    (an assumed figure persisted where a confirmed one is read).
 *  - Every number that is not a provider's own report carries its provenance beside
 *    it. `tokens` on a cache entry is usually an estimate, and a row that cannot say
 *    so is a row that will later be summed as if it were measured.
 * ------------------------------------------------------------------------- */

/**
 * Columns added to `cache_entries`. The 001 body keeps the §12 shape
 * (provider, model, prefix_hash, layer, tokens, written_at, ttl_s, confidence);
 * these carry the evidence trail that makes the confidence value auditable.
 */
export const M2_CACHE_ENTRY_COLUMNS = [
  // `explicit | implicit | none` as resolved by the pricing loader when the row was
  // written. Kept on the row because a later pricing correction must not silently
  // re-interpret evidence gathered under the old model.
  ["mechanism", "TEXT"],
  // What produced this row: e.g. `provider_reported_read`, `provider_reported_write`,
  // `assumed_write`. This is the field that makes I3 checkable after the fact.
  ["evidence", "TEXT"],
  // Provenance of `tokens`: measured | estimated | unavailable (prefix/tokens.js).
  ["tokens_provenance", "TEXT"],
  // Version string of the pricing record in force, for traceability (§9.2 `version`).
  ["pricing_version", "TEXT"],
  ["updated_at", "INTEGER"],
  // When a provider last reported this prefix (a read, or the write that created it).
  // NULL means never, which is exactly the difference between `confirmed` and `assumed`.
  ["confirmed_at", "INTEGER"],
  ["reads_observed", "INTEGER NOT NULL DEFAULT 0"],
  ["writes_observed", "INTEGER NOT NULL DEFAULT 0"],
];

/**
 * Observed provider results, one row per upstream response, keyed to the M1 turn.
 *
 * §12 puts this material in `attempts`, whose `decision_id` is `NOT NULL REFERENCES
 * decisions(id)`. M2 produces no Decision (that is M3), so an M2 observation cannot
 * satisfy that foreign key, and making it nullable would mean rebuilding a released
 * table — destructive, which §12.3 forbids. So M2 records results against the turn it
 * already owns, in a table shaped like `attempts` so M3 can union or migrate them
 * mechanically. `attempt_id` is the forward link and stays NULL in M2.
 *
 * `usage_provenance` uses M1's `TOKEN_PROVENANCE` vocabulary rather than a second one:
 * `measured` when the provider *sent* usage, `unavailable` when it sent none, and
 * `estimated` for the one case where numbers exist that no provider reported: 9Router's
 * own byte-length substitute (`finalizeStream` → `estimateUsage`, stamped
 * `estimated: true`). Filing that as `measured` would be the fabrication — an estimate
 * wearing a measurement's label — so the row says whose arithmetic produced it. A missing
 * count still stays missing; nothing here invents one.
 */
export const TURN_RESULTS_DDL = `
CREATE TABLE IF NOT EXISTS turn_results (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_idx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  reported_model TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  usage_in INTEGER,
  usage_out INTEGER,
  usage_cache_read INTEGER,
  usage_cache_write INTEGER,
  usage_provenance TEXT NOT NULL,
  cache_confidence TEXT NOT NULL,
  mechanism TEXT,
  pricing_key TEXT,
  pricing_version TEXT,
  labels TEXT,
  attempt_id TEXT,
  PRIMARY KEY (session_id, turn_idx, seq)
)`;

/**
 * Columns added to `turn_results` so a *failed* provider attempt can be recorded as the
 * failure it was (§19.4, Q3).
 *
 * The 003 body records what a provider returned. It has no room for what a provider did
 * instead of returning: the error class, the retry window it asked for, how long the
 * attempt took before it gave up. Without those a failed attempt is indistinguishable from
 * an attempt that succeeded and reported nothing, and Q3's *forced* move — the in-turn
 * `accountFallback` retry — cannot be told apart from an ordinary route change.
 *
 * All four are nullable with no default, because every one of them is genuinely unknown
 * for some real failure: a socket that never opened has no HTTP status and no error class
 * beyond `unknown`, a 500 with no `retry-after` asked for no window, and a request aborted
 * before the first byte has no TTFB. A zero in any of these columns would be a measurement
 * nobody made (I4).
 *
 * `error_class` uses the existing `RouteExecutor` taxonomy (`ports/routeExecutor.js`), not
 * a second one, and `attempts` already carries the same four column names — M3 can union
 * the two tables without a translation step.
 *
 * What is deliberately absent: the provider's error *message*. §14 forbids storing upstream
 * text, an error body routinely quotes the request, and no measure needs the string to
 * count a failure. There is no column it could go in, which is how that stays true.
 */
export const M2_TURN_RESULT_OUTCOME_COLUMNS = [
  ["error_class", "TEXT"],
  ["retry_after_s", "INTEGER"],
  ["ttfb_ms", "INTEGER"],
  ["total_ms", "INTEGER"],
];

/**
 * Columns added to `experiments` and `fixtures` (§19.4).
 *
 * `report_path` is what makes a `verified_by` citation followable: a pricing file may
 * point at a markdown report, and without the path stored beside the row the link is
 * only as good as somebody's memory of where the file went.
 */
export const M2_EXPERIMENT_COLUMNS = [
  ["report_path", "TEXT"],
  ["error_band", "TEXT"],
  ["harness_notes", "TEXT"],
];

/** §15 provenance, on the row rather than only inside the fixture file. */
export const M2_FIXTURE_COLUMNS = [
  // `synthetic | captured`. Never defaulted to `captured`: §15 requires that a
  // synthetic fixture can never be mistaken for recorded traffic.
  ["source", "TEXT NOT NULL DEFAULT 'synthetic'"],
  ["path", "TEXT"],
  ["content_hash", "TEXT"],
];

/** Indices M2 needs. */
export const M2_INDICES = [
  `CREATE INDEX IF NOT EXISTS ix_cache_entries_route ON cache_entries(provider, model)`,
  `CREATE INDEX IF NOT EXISTS ix_turn_results_provider ON turn_results(provider, at)`,
  `CREATE INDEX IF NOT EXISTS ix_turn_results_at ON turn_results(at)`,
];

/** Tables introduced by M2. */
export const M2_TABLES = ["turn_results"];


/* ------------------------------------------------------------------------- *
 * Prefix-rule provenance (schema version 5). Migration 005 owns these.
 * ------------------------------------------------------------------------- */

/**
 * Which normalization rule produced a stored prefix observation.
 *
 * The prefix comparison now reports two verdicts: the strict, byte-for-byte one, and
 * an effective one that may have been softened at exactly one boundary index by the
 * cache-bookkeeping rule in `continuity/prefix/bookkeeping.js`. `relation` keeps its
 * meaning as *the verdict identity was resolved on*, so without a stamp saying which
 * rule was in force a reader could not tell a strict extension recorded last month
 * from a softened one recorded today. That ambiguity is the thing these columns exist
 * to prevent.
 *
 * NULL is a real and meaningful value: the row was written before the rule existed,
 * so its `relation` is strict by construction and there is no `strict_relation` to
 * compare it against. Nothing is back-filled — inventing a version for an observation
 * that predates it would be a fabricated measurement.
 */
export const PREFIX_RULE_TURN_COLUMNS = [
  // The rule set in force when this turn was observed, e.g. "r1". NULL = pre-rule.
  ["prefix_rule_version", "TEXT"],
  // The unrelaxed verdict and index, always recorded, so the strict series stays
  // measurable after the effective one starts differing from it.
  ["strict_relation", "TEXT"],
  ["strict_divergence_index", "INTEGER"],
];

/**
 * The one extra digest per session the boundary re-test needs.
 *
 * `final_digest_norm` is the normalized digest of the last message of the recorded
 * sequence — a `c1:` digest of that message with the bookkeeping fields removed. One
 * value, not a second digest chain: the strict test can only reach the boundary index
 * by having already proved every earlier index byte-identical, so the earlier ones can
 * never need a normalized form. Still a one-way hash of one message, so it tells a
 * reader nothing the existing `digests_json` did not already.
 */
export const PREFIX_RULE_SESSION_PREFIX_COLUMNS = [
  ["final_digest_norm", "TEXT"],
  ["prefix_rule_version", "TEXT"],
];
