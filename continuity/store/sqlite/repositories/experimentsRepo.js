/**
 * experimentsRepo — one row per evidence run (§19.4).
 *
 * The row is the claim, and the review is what gives it force: `verdict` starts
 * `pending` and only a human moves it to `sufficient` or `insufficient`, with
 * `reviewed_by`. "A run does not unblock anything by existing", so this repository
 * refuses to write a graded verdict without a reviewer name — the rule lives in the
 * write path rather than in a convention somebody follows.
 */

const EXPERIMENT_COLUMNS = `id, question, measure, ran_at, harness_version, engine_version,
  inputs_json, result_json, n, verdict, reviewed_by, reviewed_at, unblocks,
  report_path, error_band, harness_notes`;

export const VERDICTS = Object.freeze(["pending", "sufficient", "insufficient"]);

export function insertExperiment(db, e) {
  if (!VERDICTS.includes(e.verdict ?? "pending")) {
    throw new Error(`[continuity][experiments] unknown verdict ${e.verdict}`);
  }
  db.run(
    `INSERT INTO experiments (${EXPERIMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.id,
      e.question,
      e.measure,
      e.ran_at,
      e.harness_version,
      e.engine_version,
      typeof e.inputs_json === "string" ? e.inputs_json : JSON.stringify(e.inputs_json ?? {}),
      typeof e.result_json === "string" ? e.result_json : JSON.stringify(e.result_json ?? {}),
      Number.isInteger(e.n) ? e.n : 0,
      e.verdict ?? "pending",
      e.reviewed_by ?? null,
      e.reviewed_at ?? null,
      e.unblocks ?? null,
      e.report_path ?? null,
      e.error_band ?? null,
      e.harness_notes ?? null,
    ],
  );
  return e.id;
}

/**
 * Grade a run. A graded verdict without a reviewer is refused: an unreviewed
 * `sufficient` is the one way this table could quietly unblock a milestone.
 */
export function setVerdict(db, id, { verdict, reviewed_by, reviewed_at }) {
  if (!VERDICTS.includes(verdict)) throw new Error(`[continuity][experiments] unknown verdict ${verdict}`);
  if (verdict !== "pending" && !String(reviewed_by ?? "").trim()) {
    throw new Error("[continuity][experiments] a graded verdict requires reviewed_by (§19.4)");
  }
  db.run(`UPDATE experiments SET verdict = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`, [
    verdict,
    reviewed_by ?? null,
    Number.isInteger(reviewed_at) ? reviewed_at : null,
    id,
  ]);
  return getExperiment(db, id);
}

export function getExperiment(db, id) {
  return db.get(`SELECT ${EXPERIMENT_COLUMNS} FROM experiments WHERE id = ?`, [id]) ?? null;
}

export function listExperiments(db, { question = null, measure = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (question) {
    where.push("question = ?");
    args.push(question);
  }
  if (measure) {
    where.push("measure = ?");
    args.push(measure);
  }
  args.push(limit);
  return (
    db.all(
      `SELECT ${EXPERIMENT_COLUMNS} FROM experiments
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ran_at DESC, id DESC LIMIT ?`,
      args,
    ) || []
  );
}

/** Latest run per question — the body of `dxrouter measure --status`. */
export function latestByQuestion(db) {
  const rows = db.all(
    `SELECT ${EXPERIMENT_COLUMNS} FROM experiments
      WHERE ran_at = (SELECT MAX(ran_at) FROM experiments e2 WHERE e2.question = experiments.question)
      ORDER BY question`,
  );
  return (rows || []).map((r) => ({ ...r }));
}

export function countExperiments(db) {
  return Number(db.get(`SELECT COUNT(*) AS n FROM experiments`)?.n) || 0;
}
