/**
 * cacheRepo — persistence for `cache_entries`.
 *
 * The table was created empty in M0 with the §12 shape; migration 003 added the
 * evidence columns. One row is one belief about one prefix layer on one route, keyed
 * `(provider, model, prefix_hash, layer)` — not by session, because a cache lives
 * upstream and two sessions sending the same bytes to the same model are looking at the
 * same thing.
 *
 * Two deliberate choices:
 *
 *  - **Read-merge-write inside the caller's transaction, not SQL upsert.** The merge
 *    rule (counters accumulate, token counts replace, `written_at` moves only on real
 *    evidence) lives in `cache/entry.js` and is tested there. Expressing half of it in
 *    an `ON CONFLICT DO UPDATE` clause would give the rule two homes and one of them
 *    would rot. `upsertCacheEntry` therefore takes an already-merged entry.
 *  - **Nothing here deletes on invalidation.** §9.1 invalidation is a read-side mask
 *    (see `cache/ledger.js`): the upstream cache does not forget because our prefix
 *    changed, and a later turn may return to the old prefix. The only deletion is
 *    expiry-plus-grace, run by the sweeper.
 *
 * Rows are validated through `createCacheEntry` on the way out, so a row that violates
 * the entry contract — a `confirmed` row with no provider evidence, say — is a loud
 * failure at read time rather than a quiet lie in an arithmetic.
 */

import { createCacheEntry } from "../../../cache/entry.js";

const CACHE_COLUMNS = `provider, model, prefix_hash, layer, tokens, written_at, ttl_s, confidence,
  mechanism, evidence, tokens_provenance, pricing_version, updated_at, confirmed_at,
  reads_observed, writes_observed`;

function toEntry(row) {
  return row ? createCacheEntry(row) : null;
}

/** One belief, or null. */
export function getCacheEntry(db, { provider, model, prefix_hash, layer } = {}) {
  const row = db.get(
    `SELECT ${CACHE_COLUMNS} FROM cache_entries
      WHERE provider = ? AND model = ? AND prefix_hash = ? AND layer = ?`,
    [provider, model, prefix_hash, layer],
  );
  return toEntry(row);
}

/** Every layer believed cached for one route. Ordered for stable output. */
export function listCacheEntriesForRoute(db, provider, model) {
  const rows = db.all(
    `SELECT ${CACHE_COLUMNS} FROM cache_entries WHERE provider = ? AND model = ? ORDER BY layer, written_at DESC`,
    [provider, model],
  );
  return (rows || []).map(toEntry);
}

/**
 * The lookup the ledger needs: the entries for this route among a specific set of
 * layer hashes. Parameterized `IN` list, built from the hash count — never string
 * interpolation of a value.
 */
export function listCacheEntriesForHashes(db, provider, model, hashes = []) {
  const list = [...new Set((hashes || []).filter(Boolean))];
  if (!list.length) return [];
  const holes = list.map(() => "?").join(", ");
  const rows = db.all(
    `SELECT ${CACHE_COLUMNS} FROM cache_entries
      WHERE provider = ? AND model = ? AND prefix_hash IN (${holes})`,
    [provider, model, ...list],
  );
  return (rows || []).map(toEntry);
}

/**
 * Write one already-merged entry.
 *
 * `INSERT OR REPLACE` rather than an upsert clause: the row is a complete restatement
 * of the belief, the merge already happened in `applyEvidence`, and REPLACE works on
 * every driver in the fallback chain. `cache_entries` is not referenced by any foreign
 * key, so the delete-then-insert REPLACE performs cascades nothing.
 */
export function upsertCacheEntry(db, entry) {
  const e = createCacheEntry(entry);
  db.run(
    `INSERT OR REPLACE INTO cache_entries (${CACHE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.provider,
      e.model,
      e.prefix_hash,
      e.layer,
      e.tokens,
      e.written_at,
      e.ttl_s,
      e.confidence,
      e.mechanism,
      e.evidence,
      e.tokens_provenance,
      e.pricing_version,
      e.updated_at,
      e.confirmed_at,
      e.reads_observed,
      e.writes_observed,
    ],
  );
  return e;
}

/**
 * §12.3 retention: a row is deleted at `written_at + ttl_s + grace`, not when it
 * expires. The grace is what keeps "expired" and "never existed" distinguishable for an
 * hour, which is the difference between a diagnosable miss and a mystery.
 */
export function deleteExpiredCacheEntries(db, now, { graceMs = 3_600_000, limit = 5000 } = {}) {
  const rows = db.all(
    `SELECT provider, model, prefix_hash, layer FROM cache_entries
      WHERE written_at + (ttl_s * 1000) + ? <= ?
      LIMIT ?`,
    [graceMs, now, limit],
  );
  for (const r of rows || []) {
    db.run(
      `DELETE FROM cache_entries WHERE provider = ? AND model = ? AND prefix_hash = ? AND layer = ?`,
      [r.provider, r.model, r.prefix_hash, r.layer],
    );
  }
  return (rows || []).length;
}

/** Counts per provider and confidence — the persisted side of the coverage report. */
export function cacheEntryStats(db) {
  const rows = db.all(
    `SELECT provider, confidence, COUNT(*) AS n, SUM(tokens) AS tokens
       FROM cache_entries GROUP BY provider, confidence ORDER BY provider, confidence`,
  );
  return (rows || []).map((r) => ({
    provider: r.provider,
    confidence: r.confidence,
    entries: Number(r.n) || 0,
    tokens: Number(r.tokens) || 0,
  }));
}

export function countCacheEntries(db) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM cache_entries`)?.n) || 0;
}
