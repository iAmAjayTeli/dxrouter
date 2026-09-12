/**
 * turnResultsRepo — what a provider actually did, recorded against an M1 turn.
 *
 * §12.1 puts this material in `attempts`, whose `decision_id` is
 * `TEXT NOT NULL REFERENCES decisions(id)`. M2 produces no Decision (that is M3), and
 * relaxing a released column would mean rebuilding a shipped table, which §12.3 forbids.
 * So results land in an `attempts`-shaped table keyed by the turn, with `attempt_id` as
 * the forward link a later milestone fills in. See `M2-IMPLEMENTATION-MAP.md`.
 *
 * What a row is: the route, the outcome, the four usage counts *as the provider reported
 * them*, and the provenance of each. What a row is not: a body, a prompt, a completion,
 * an error message from upstream. There is no column for any of those, which is how §14
 * stays true under pressure.
 *
 * `usage_provenance` and `cache_confidence` are `NOT NULL` on purpose. A number without
 * its provenance is exactly the thing I3 forbids, and a nullable provenance column is an
 * invitation to write one.
 */

const RESULT_COLUMNS = `session_id, turn_idx, seq, at, provider, model, reported_model, status,
  http_status, usage_in, usage_out, usage_cache_read, usage_cache_write,
  usage_provenance, cache_confidence, mechanism, pricing_key, pricing_version, labels, attempt_id,
  error_class, retry_after_s, ttfb_ms, total_ms`;

/** Next free sequence for this turn. Call inside the write transaction. */
export function nextResultSeq(db, sessionId, turnIdx) {
  const row = db.get(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM turn_results WHERE session_id = ? AND turn_idx = ?`,
    [sessionId, turnIdx],
  );
  return row?.next ?? 0;
}

export function insertTurnResult(db, r) {
  db.run(
    `INSERT INTO turn_results (${RESULT_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.session_id,
      r.turn_idx,
      r.seq,
      r.at,
      r.provider ?? null,
      r.model ?? null,
      r.reported_model ?? null,
      r.status,
      Number.isInteger(r.http_status) ? r.http_status : null,
      Number.isInteger(r.usage_in) ? r.usage_in : null,
      Number.isInteger(r.usage_out) ? r.usage_out : null,
      // Null means "the provider said nothing", zero means "the provider said zero".
      // Collapsing the two would turn provider silence into a measured cache miss.
      Number.isInteger(r.usage_cache_read) ? r.usage_cache_read : null,
      Number.isInteger(r.usage_cache_write) ? r.usage_cache_write : null,
      r.usage_provenance,
      r.cache_confidence,
      r.mechanism ?? null,
      r.pricing_key ?? null,
      r.pricing_version ?? null,
      r.labels ?? null,
      r.attempt_id ?? null,
      // How the attempt ended. Every one of these is null when it was not observed, and
      // null here means "not known", never "zero" — a timeout with no first byte has no
      // TTFB, and a 500 that named no retry window asked for none (I4).
      r.error_class ?? null,
      Number.isInteger(r.retry_after_s) ? r.retry_after_s : null,
      Number.isInteger(r.ttfb_ms) ? r.ttfb_ms : null,
      Number.isInteger(r.total_ms) ? r.total_ms : null,
    ],
  );
  return r.seq;
}

/** Allocate the sequence and insert, both inside the caller's transaction. */
export function insertTurnResultAtNextSeq(db, result) {
  const seq = nextResultSeq(db, result.session_id, result.turn_idx);
  insertTurnResult(db, { ...result, seq });
  return seq;
}

export function listTurnResults(db, sessionId, { limit = 500 } = {}) {
  return (
    db.all(
      `SELECT ${RESULT_COLUMNS} FROM turn_results WHERE session_id = ?
        ORDER BY turn_idx, seq LIMIT ?`,
      [sessionId, limit],
    ) || []
  );
}

export function getTurnResults(db, sessionId, turnIdx) {
  return (
    db.all(
      `SELECT ${RESULT_COLUMNS} FROM turn_results WHERE session_id = ? AND turn_idx = ? ORDER BY seq`,
      [sessionId, turnIdx],
    ) || []
  );
}

export function countTurnResults(db) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM turn_results`)?.n) || 0;
}

/**
 * The `coverage` measure (§19.4, Q1), computed from persisted rows rather than from a
 * running total somebody has to keep correct.
 *
 * `reported_read` counts rows where the provider gave us a cache-read number at all —
 * including zero, which is a report. `silent` counts rows where the field was absent.
 * The distinction is the whole measurement: a provider that never reports cannot produce
 * `confirmed` evidence, no matter how warm its cache actually is.
 *
 * **`groupBy`** exists because the alias is not the unit the question is about. 9Router
 * reaches Anthropic under `claude`, `claude-code`, `kiro` and more; asking "does Anthropic
 * report cache reads?" per alias splits one vendor's evidence into several thin samples
 * and lets a rarely-used alias look like a distinct finding. `groupBy: "pricing_key"`
 * groups by the vendor the adapter actually mapped the alias to (`COALESCE(pricing_key,
 * provider)`, so an unmapped alias stays visible as itself rather than merging into a
 * neighbour — the same conservatism as §9.3's "no file" path).
 *
 * The provenance counts answer a question the confidence columns cannot: `estimated` rows
 * carry numbers 9Router computed from byte lengths, not numbers a provider sent. A
 * coverage percentage that mixed them in would count our own arithmetic as provider
 * reporting (I3), so the split is available to any consumer that reports a percentage.
 */
export function cacheReportingCoverage(db, { since = 0, provider = null, groupBy = "provider" } = {}) {
  const where = ["at >= ?"];
  const args = [since];
  if (provider) {
    where.push("provider = ?");
    args.push(provider);
  }
  // Two allowed groupings, both literal: the value is chosen here, never interpolated
  // from a caller's string, so this cannot become an injection point.
  const key = groupBy === "pricing_key" ? "COALESCE(pricing_key, provider)" : "provider";
  // A failed attempt got no response, so it can neither report a cache field nor stay
  // silent about one: counting it in the denominator would turn provider *unavailability*
  // into evidence that a provider does not report cache reads. Every coverage counter below
  // is therefore taken over responses only, and the failures are reported beside them as
  // their own count.
  //
  // `status = 'ok'` rather than `<> 'error'`, so this uses the one definition of failure the
  // rest of the engine uses (`observeCacheResult`, `replayFixture`): anything that is not a
  // clean response is not a response. `unknown` — what a killed process leaves behind — has
  // no cache fields to read either, and letting it into the denominator would count a
  // crashed run as a provider that stayed silent.
  const responded = `status = 'ok'`;
  const rows = db.all(
    `SELECT ${key} AS group_key,
            SUM(CASE WHEN ${responded} THEN 1 ELSE 0 END) AS total,
            COUNT(*) AS attempts,
            SUM(CASE WHEN NOT (${responded}) THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN ${responded} AND usage_cache_read IS NOT NULL THEN 1 ELSE 0 END) AS reported_read,
            SUM(CASE WHEN ${responded} AND usage_cache_write IS NOT NULL THEN 1 ELSE 0 END) AS reported_write,
            SUM(CASE WHEN ${responded} AND usage_cache_read IS NULL AND usage_cache_write IS NULL THEN 1 ELSE 0 END) AS silent,
            SUM(CASE WHEN ${responded} AND cache_confidence = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN ${responded} AND cache_confidence = 'assumed' THEN 1 ELSE 0 END) AS assumed,
            SUM(CASE WHEN ${responded} AND cache_confidence = 'unknown' THEN 1 ELSE 0 END) AS unknown,
            -- The provider said nothing about its cache, and we believed a window was
            -- open anyway. This is the count section 19.4 calls "silent-but-cached": the
            -- population where cache economics would rest on assumed alone.
            SUM(CASE WHEN ${responded} AND usage_cache_read IS NULL AND cache_confidence = 'assumed' THEN 1 ELSE 0 END)
              AS silent_but_assumed,
            SUM(CASE WHEN ${responded} THEN COALESCE(usage_cache_read, 0) ELSE 0 END) AS cache_read_tokens,
            SUM(CASE WHEN ${responded} THEN COALESCE(usage_cache_write, 0) ELSE 0 END) AS cache_write_tokens,
            SUM(CASE WHEN ${responded} THEN COALESCE(usage_in, 0) ELSE 0 END) AS input_tokens,
            -- Provenance of the numbers behind the counts above. The estimated column is
            -- 9Router's own byte-length substitute for a provider that sent no usage at
            -- all; it is not a report, and a consumer that treats it as one is claiming a
            -- measurement nobody made. (No backticks in here: this is a template literal.)
            SUM(CASE WHEN ${responded} AND usage_provenance = 'measured' THEN 1 ELSE 0 END) AS measured,
            SUM(CASE WHEN ${responded} AND usage_provenance = 'estimated' THEN 1 ELSE 0 END) AS estimated,
            SUM(CASE WHEN ${responded} AND usage_provenance = 'unavailable' THEN 1 ELSE 0 END) AS unavailable
       FROM turn_results
      WHERE ${where.join(" AND ")}
      GROUP BY group_key
      ORDER BY group_key`,
    args,
  );
  return (rows || []).map((r) => ({
    // `provider` keeps its name for the default grouping, because that is what it is.
    // Under `pricing_key` it is the vendor key, and `group_by` says which one a reader
    // is looking at rather than leaving the label ambiguous.
    provider: r.group_key,
    group_key: r.group_key,
    group_by: groupBy === "pricing_key" ? "pricing_key" : "provider",
    // Responses observed. `attempts` is every row, failures included, and `failed` is the
    // difference — a reader can see the denominator and what was kept out of it.
    total: Number(r.total) || 0,
    responses: Number(r.total) || 0,
    attempts: Number(r.attempts) || 0,
    failed: Number(r.failed) || 0,
    reported_read: Number(r.reported_read) || 0,
    reported_write: Number(r.reported_write) || 0,
    silent: Number(r.silent) || 0,
    confirmed: Number(r.confirmed) || 0,
    assumed: Number(r.assumed) || 0,
    unknown: Number(r.unknown) || 0,
    silent_but_assumed: Number(r.silent_but_assumed) || 0,
    cache_read_tokens: Number(r.cache_read_tokens) || 0,
    cache_write_tokens: Number(r.cache_write_tokens) || 0,
    input_tokens: Number(r.input_tokens) || 0,
    measured: Number(r.measured) || 0,
    estimated: Number(r.estimated) || 0,
    unavailable: Number(r.unavailable) || 0,
  }));
}

/**
 * Every observed route in order, across sessions — the input the `return_rate` measure
 * needs to find *moves* (§19.4, Q3).
 *
 * A move is a change of `(provider, model)` between consecutive rows of one session, and
 * that is only visible in a sequence: no column marks one, and nothing in M2 causes one.
 * The ordering is `(session_id, turn_idx, seq)` because `seq > 0` inside one `turn_idx` is
 * an in-turn `accountFallback` retry — a genuinely *forced* move, which is exactly the
 * population Q3 asks about, and which would be invisible if rows were collapsed per turn.
 *
 * Deliberately not a "moves" query: the harvesting rule belongs in the measure, where it
 * can be tested and changed without a migration, and where a reader can see it. This
 * returns rows.
 */
export function routeSequence(db, { since = 0, limit = 20000 } = {}) {
  return (
    db.all(
      `SELECT session_id, turn_idx, seq, at, provider, model, pricing_key, status, http_status,
              mechanism, cache_confidence, usage_provenance, usage_in, usage_cache_read, usage_cache_write,
              error_class, retry_after_s, ttfb_ms, total_ms
         FROM turn_results
        WHERE at >= ?
        ORDER BY session_id, turn_idx, seq
        LIMIT ?`,
      [since, limit],
    ) || []
  );
}

/** Retention (§12.3), mirroring the M1 turn sweep. */
export function deleteTurnResultsBefore(db, cutoff) {
  db.run(`DELETE FROM turn_results WHERE at < ?`, [cutoff]);
}
