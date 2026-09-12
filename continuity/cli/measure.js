/**
 * `dxrouter measure` — run one evidence measure, or read the gate (§19.4).
 *
 * The formatting here carries one argument: a run is not an answer. `--status` therefore
 * prints the verdict column before the number, names the reviewer (or the absence of one),
 * and states which questions still block M3. A status table that led with a headline figure
 * would let an ungraded run read as settled evidence, which is the exact failure §19.4
 * exists to prevent.
 *
 * `blocked` is rendered as a first-class outcome with its reason, never as an error and
 * never as a zero.
 */

import { BLOCKED_REASON, RUN_STATUS } from "../evidence/harness.js";
import { LIVE_MEASURES, MEASURE_NAMES } from "../evidence/measures/index.js";
import { M3_GATE } from "../evidence/questions.js";

const pad = (v, n) => String(v ?? "").padEnd(n);

export const STATUS_COLUMNS = Object.freeze(["QUESTION", "VERDICT", "REVIEWED BY", "N", "ERROR BAND", "MEASURE", "RAN AT", "BLOCKS"]);

const iso = (at) => (Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");

/** The §19.4 status table plus the gate explanation. */
export function renderStatus(status, { gate = M3_GATE } = {}) {
  const head = [
    pad(STATUS_COLUMNS[0], 8),
    pad(STATUS_COLUMNS[1], 12),
    pad(STATUS_COLUMNS[2], 16),
    pad(STATUS_COLUMNS[3], 6),
    pad(STATUS_COLUMNS[4], 22),
    pad(STATUS_COLUMNS[5], 20),
    pad(STATUS_COLUMNS[6], 22),
    STATUS_COLUMNS[7],
  ].join(" ");

  const lines = status.questions.map((q) =>
    [
      pad(q.question, 8),
      pad(q.verdict, 12),
      pad(q.reviewed_by ?? "-", 16),
      pad(q.n, 6),
      pad(q.error_band ?? "-", 22),
      pad(q.measure ?? (q.answerable_here ? "-" : "(no measure)"), 20),
      pad(iso(q.ran_at), 22),
      q.blocks?.join(",") || "-",
    ].join(" ").trimEnd(),
  );

  const out = [head, ...lines, "", `${status.total_runs} recorded run(s). A run does not unblock anything by existing.`];
  const g = status.gate;
  out.push("", `M3 gate (${gate.join(", ")}): ${g.open ? "OPEN" : "BLOCKED"}`);
  for (const q of g.questions) {
    if (q.satisfied) continue;
    const why =
      q.verdict === "missing"
        ? "no run recorded"
        : q.verdict === "pending"
          ? "run recorded, awaiting human review"
          : q.verdict === "insufficient"
            ? "reviewed and judged insufficient"
            : `verdict ${q.verdict} without a reviewer`;
    out.push(`  - ${q.question}: ${why}`);
  }
  return out.join("\n");
}

/** One completed run, rendered for the person who has to grade it. */
export function renderRun({ row, result, report_path, markdown } = {}) {
  const out = [
    `${row.measure} -> ${row.question}   run ${row.id}`,
    `status:      ${result.status}${result.blocked_reason ? ` (${result.blocked_reason})` : ""}`,
    `n:           ${result.n ?? 0}`,
    // Which population produced that n. A percentage whose population is unstated is the
    // §19.4 failure mode, and the operator reading this line is the person who would
    // otherwise have to guess.
    ...(result.population
      ? [`population:  ${result.population}${result.population_source && result.population_source !== result.population ? ` (${result.population_source})` : ""}`]
      : []),
    `error band:  ${result.error?.band ?? "unavailable"} (${result.error?.basis ?? "no basis"})`,
    `verdict:     ${row.verdict} — set it yourself; the harness never grades its own run`,
    `unblocks:    ${row.unblocks ?? "-"}`,
  ];
  if (report_path) out.push(`report:      ${report_path}`);
  else if (markdown) out.push("report:      not written (no report directory supplied)");

  if (result.status === RUN_STATUS.BLOCKED) {
    out.push("", `This measurement is UNAVAILABLE, not zero. Reason: ${result.blocked_reason}.`);
    if (result.blocked_reason === BLOCKED_REASON.NOT_OPTED_IN && result.plan) {
      out.push(
        `Running it would send ${result.plan.requests} request(s) (~${result.plan.approx_input_tokens} input tokens) on your credentials and bill your account.`,
      );
    }
  }
  for (const note of result.notes ?? []) out.push(`note: ${note}`);
  return out.join("\n");
}

/**
 * The help text, which §19.4 treats as part of the contract: the document names a command
 * line, and a flag that exists only in prose is a flag an operator cannot run. Every option
 * the script accepts is listed here, grouped by what it is for, so the two stay comparable
 * by reading rather than by trust.
 */
export const USAGE_LINES = Object.freeze([
  `  dxrouter measure <${MEASURE_NAMES.join("|")}>`,
  "  dxrouter measure --status",
  "",
  "  Which population to measure:",
  "    --fixture <path>      a fixture file or directory; becomes the WHOLE population,",
  "                          so operator-captured fixtures are never pooled with the",
  "                          repository's synthetic ones inside one n",
  "                          prefix_stability with no --fixture measures the OBSERVED M1",
  "                          sessions in the store instead; the two never mix in one n",
  "    --window <duration>   persisted rows this recent (24h, 7d, 30m); --since wins",
  "    --since <epoch-ms>    persisted rows at or after this instant",
  "    --provider <alias>    restrict the population to one provider alias",
  "    --model <id>          the model to measure (required by cache_probe)",
  "",
  `  ${LIVE_MEASURES.join(", ")} send real requests and cost real money; they need --yes.`,
  "  Its cost — requests, tokens and wall-clock — is printed before anything is sent:",
  "    --base-url <url>      provider endpoint (https, or http on loopback only)",
  "    --api-key-env <NAME>  the NAME of the env var holding the key; no stored",
  "                          9Router credential is ever read for a probe",
  "    --protocol <p>        openai | anthropic (default openai)",
  "    --ladder <gaps>       TTL rungs, e.g. 30s,2m,5.5m,65m; the answer is the interval",
  "                          between the last rung that hit and the first that missed",
  "    --arms <a>            above | below | both, relative to a verified TTL: buy only",
  "                          the half of the ladder you do not already believe",
  "    --repetitions <n>     times to walk the ladder (default 1)",
  "    --min-tokens <n>      prefix size in tokens (default 2048)",
  "    --gap <duration>      write-to-read delay when no --ladder is given (default 5s)",
]);

export default renderStatus;
