/**
 * fixturesRepo — the recorded workloads a measure replays (§19.4).
 *
 * `source` is the column that keeps §15 honest: `synthetic` or `captured`, written by
 * whoever registers the fixture, never inferred. A measure reports it in its output, so
 * a result derived from synthetic material cannot be read later as a real-workload
 * measurement.
 *
 * `bodies_included` stays 0 for everything M2 ships: a fixture is hashes and counts.
 * The `bodies` table exists (M0 created it empty) and remains unused.
 */

const FIXTURE_COLUMNS = `id, label, project_kind, turns, recorded_at, bodies_included, source, path, content_hash`;

export const FIXTURE_SOURCES = Object.freeze(["synthetic", "captured"]);

export function upsertFixture(db, f) {
  const source = f.source ?? "synthetic";
  if (!FIXTURE_SOURCES.includes(source)) {
    throw new Error(`[continuity][fixtures] source must be one of ${FIXTURE_SOURCES.join(", ")}`);
  }
  db.run(`INSERT OR REPLACE INTO fixtures (${FIXTURE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    f.id,
    f.label ?? null,
    f.project_kind ?? null,
    Number.isInteger(f.turns) ? f.turns : 0,
    Number.isInteger(f.recorded_at) ? f.recorded_at : 0,
    f.bodies_included ? 1 : 0,
    source,
    f.path ?? null,
    f.content_hash ?? null,
  ]);
  return f.id;
}

export function getFixture(db, id) {
  return db.get(`SELECT ${FIXTURE_COLUMNS} FROM fixtures WHERE id = ?`, [id]) ?? null;
}

export function listFixtures(db, { source = null, project_kind = null } = {}) {
  const where = [];
  const args = [];
  if (source) {
    where.push("source = ?");
    args.push(source);
  }
  if (project_kind) {
    where.push("project_kind = ?");
    args.push(project_kind);
  }
  return (
    db.all(
      `SELECT ${FIXTURE_COLUMNS} FROM fixtures ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
      args,
    ) || []
  );
}

export function countFixtures(db) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM fixtures`)?.n) || 0;
}
