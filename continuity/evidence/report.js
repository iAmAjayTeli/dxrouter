/**
 * The markdown a measure run leaves behind (§19.4).
 *
 * A row in `experiments` is the record; the report is the thing a human can actually
 * review before writing a verdict, which is why it leads with what would let a reviewer
 * say "insufficient": the sample size, the error band, whether the evidence was synthetic,
 * and every `blocked` reason. A report that opened with the headline number and buried the
 * provenance would make grading harder than not reporting at all.
 *
 * Pure: returns a filename and a string. The host writes it, because the path depends on
 * the data root, which lives outside the engine (I1).
 */

import { QUESTIONS } from "./questions.js";

/** `<question>-<measure>-<YYYY-MM-DD>.md`, as §19.4 names it. */
export function reportFilename({ question, measure, ran_at }) {
  const day = new Date(Number.isFinite(ran_at) ? ran_at : 0).toISOString().slice(0, 10);
  return `${question ?? "Qx"}-${measure ?? "measure"}-${day}.md`;
}

const fence = (value) => ["```json", JSON.stringify(value ?? null, null, 2), "```"].join("\n");

function table(rows, columns) {
  if (!rows?.length) return "_none_";
  const head = `| ${columns.join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => String(r[c] ?? "")).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

/** `band — _basis_`, the shape every estimator in `stats.js` returns. */
const bandOf = (error) => (error?.band ? `${error.band} — _${error.basis ?? "no basis stated"}_` : "unavailable");

/** A section with its own heading, dropped entirely when there is nothing in it. */
const section = (heading, body) => (body ? [`### ${heading}`, "", body, ""].join("\n") : "");

/** The per-measure detail section. Each measure gets the tables that make it reviewable. */
function detailFor(result) {
  switch (result?.measure) {
    case "coverage":
      return [
        section(
          "By provider alias",
          table(result.by_provider ?? [], [
            "provider",
            "population",
            "n",
            "reported_read",
            "silent",
            "silent_but_assumed",
            "confirmed",
            "assumed",
            "unknown",
            "read_coverage_pct",
          ]),
        ),
        // §9.2 names ten vendors, not 81 aliases: this is the grouping the question is
        // actually about, and an alias table alone splits one vendor into thin samples.
        section(
          "By pricing key (the vendor the alias maps to)",
          table(result.by_pricing_key ?? [], ["provider", "population", "n", "reported_read", "silent", "confirmed", "read_coverage_pct"]),
        ),
        result.provenance
          ? section(
              "Provenance of the counts",
              table([result.provenance], ["measured", "estimated", "unavailable"]) +
                "\n\n_`estimated` rows carry 9Router's own byte-length substitute for a provider that sent no usage; they cannot evidence cache reporting._",
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "prefix_stability":
      return [
        section(
          "Per session",
          table(result.sessions ?? [], [
            "fixture_id",
            "fixture_source",
            "project_kind",
            "turns",
            "first_tools_break",
            "first_system_break",
            "front_held_pct",
            "front_breaks",
            "longest_front_run",
            "warm_turns",
            "truncated",
          ]),
        ),
        // §23's three-kinds rule is about this table, not about the pooled row: a churn
        // figure that is really one repository's habits is what the rule exists to catch,
        // and it is only visible per kind.
        section(
          "By project kind",
          table(
            (result.by_project_kind ?? []).map((k) => ({
              project_kind: k.project_kind ?? "(unknown)",
              source: k.project_kind_source,
              sessions: k.sessions,
              turns: k.turns,
              front_held_pct: k.front_held_pct,
              band: k.front_held_error?.band ?? "unavailable",
              front_runs: k.front_runs_observed,
              run_survival: k.front_run_turns?.band ?? "unavailable",
            })),
            ["project_kind", "source", "sessions", "turns", "front_held_pct", "band", "front_runs", "run_survival"],
          ),
        ),
        // Churn per layer, with the band that resamples sessions rather than turns.
        section(
          "Per-layer churn (session-clustered)",
          table(
            (result.by_layer ?? []).map((l) => ({ ...l, band: l.churn_error?.band ?? "unavailable" })),
            ["layer", "turns", "churned_turns", "churn_pct", "band"],
          ),
        ),
        section(
          "Unbroken front-prefix runs",
          [
            `- **Survival (Kaplan-Meier):** ${bandOf(result.front_run_turns)}`,
            `- **Runs observed:** ${result.front_runs_observed ?? 0} (censored: ${result.front_runs_censored ?? 0})`,
            `- **Restricted mean run:** ${result.front_run_turns?.restricted_mean ?? "unavailable"} turns`,
            "",
            table(result.front_run_turns?.curve ?? [], ["t", "at_risk", "events", "survival"]),
          ].join("\n"),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    case "return_rate":
      return [
        section("Per session (inter-turn gaps)", table(result.sessions ?? [], ["session_id", "source", "population", "turns", "ttl_s"])),
        // The two quantities, named apart: opportunity, and Q3's actual question.
        section(
          "Quantities",
          [
            `- **Gap inside the believed window (opportunity):** ${result.gap_within_ttl_pct ?? "unavailable"}% of ${result.windows ?? 0} judgeable gap(s) — band ${bandOf(result.gap_within_ttl_error)}`,
            `- **P(return after an observed move):** ${result.p_return_after_move_pct ?? "unavailable"}% of ${result.moves ?? 0} move(s) — band ${bandOf(result.p_return_error)}`,
            `- **Time to return:** ${bandOf(result.time_to_return_ms)}`,
            `- **Unjudgeable gaps (no verified TTL):** ${result.unjudgeable_gaps ?? 0}`,
          ].join("\n"),
        ),
        section(
          "Observed moves harvested from turn_results",
          table(result.moves_observed ?? [], [
            "session_id",
            "from",
            "to",
            "move_cause",
            "from_status",
            "returned",
            "duration_ms",
            "returned_within_ttl",
          ]),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    case "arithmetic_accuracy":
      return table(
        (result.turns ?? []).filter((t) => t.scored),
        ["fixture_id", "turn", "predicted_read_tokens", "reported_read_tokens", "read_error_pct", "predicted_provenance"],
      );
    case "cache_probe":
      return [
        section(
          "Cost stated before sending",
          table([result.plan ?? {}], ["requests", "prefix_tokens", "approx_input_tokens", "rungs", "arms", "approx_wall_clock_ms"]),
        ),
        // The TTL answer is an interval between two rungs. It is never a point: the probe
        // observed the rungs, not the boundary.
        section(
          "TTL ladder",
          [
            `- **Measured window:** ${result.ttl_interval_s?.band ?? "unavailable"} — _${result.ttl_interval_s?.basis ?? ""}_`,
            `- **Documented TTL:** ${result.documented_ttl_s ?? "none verified"}`,
            "",
            table(result.ladder ?? [], ["gap", "reads", "reported", "silent", "hits", "reported_zero", "verdict", "reported_read_tokens"]),
          ].join("\n"),
        ),
        section(
          "Billed vs reported",
          [
            `- **Status:** \`${result.billed_vs_reported?.status ?? "unreconciled"}\``,
            `- **Reported cache-read tokens:** ${result.billed_vs_reported?.reported_read_tokens ?? 0}`,
            `- **Billed cache-read tokens:** ${result.billed_vs_reported?.billed_read_tokens ?? "_not knowable from here_"}`,
            `- _${result.billed_vs_reported?.note ?? "reconciliation is a human step"}_`,
          ].join("\n"),
        ),
        section(
          "Every request sent",
          table(result.probes ?? [], [
            "rep",
            "gap",
            "phase",
            "http_status",
            "usage_in",
            "cache_read",
            "cache_write",
            "provider_reported",
            "confidence",
            "evidence",
          ]),
        ),
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return fence(result);
  }
}

/**
 * Render the report for one run.
 *
 * @param {object} args
 * @param {object} args.row the `experiments` row from `buildExperimentRow`
 * @param {object} args.result the measure's own result object
 * @param {object} [args.inputs] what the run was given, verbatim
 */
/** `n`, and an honest account of what it does and does not contain. */
function sampleSizeLine(result) {
  const n = result?.n ?? 0;
  const synthetic = Number.isFinite(result?.n_synthetic) ? result.n_synthetic : null;
  if (synthetic === null) return String(n);
  const total = Number.isFinite(result?.n_total) ? result.n_total : null;
  // The band was built over `n`. Whether the synthetic rows are inside it is the whole
  // question, and it is answered by comparing `n` with the total the measure reduced.
  if (total !== null && total > n) return `${n} real; ${synthetic} synthetic (excluded from n)`;
  if (synthetic === 0) return `${n} (no synthetic observations)`;
  if (synthetic === n) return `${n}, all synthetic — the band describes the fixtures`;
  return `${n}, of which ${synthetic} synthetic (included in n)`;
}

export function renderReport({ row, result, inputs = {} } = {}) {
  const q = QUESTIONS[row?.question] ?? null;
  const ran = new Date(Number.isFinite(row?.ran_at) ? row.ran_at : 0).toISOString();
  // A measure that classified its own population is believed; the string match is the
  // fallback for measures that do not (and for a fixture id that says so in passing).
  const population = typeof result?.population === "string" ? result.population : null;
  const synthetic = population ? population !== "real" && population !== "none" : String(JSON.stringify(result ?? {})).includes('"synthetic"');
  // `real` covers traffic that happened; `population_source` says whether we watched it
  // here (`observed`) or someone recorded it elsewhere (`captured`). The two are both
  // evidence and are not the same evidence, so both are printed.
  const source = typeof result?.population_source === "string" && result.population_source !== population ? result.population_source : null;
  const populationLine = population
    ? `\`${population}\`${source ? ` (\`${source}\`)` : ""}${population === "real" ? "" : " — **not evidence about providers or projects**"}`
    : synthetic
      ? "**synthetic fixtures are present in this population**"
      : "no synthetic marker in the population";

  const lines = [
    `# ${row?.question ?? "Qx"} / ${row?.measure ?? "measure"}`,
    "",
    `- **Question:** ${q?.question ?? "(unregistered)"}`,
    `- **Method (§23):** ${q?.method ?? "(none recorded)"}`,
    `- **Blocks:** ${q?.blocks?.join(", ") || "nothing"}`,
    `- **Run id:** \`${row?.id ?? "?"}\``,
    `- **Ran at:** ${ran}`,
    `- **Harness / engine:** \`${row?.harness_version ?? "?"}\` / \`${row?.engine_version ?? "?"}\``,
    "",
    "## Verdict",
    "",
    `- **Status:** \`${result?.status ?? "?"}\`${result?.blocked_reason ? ` (\`${result.blocked_reason}\`)` : ""}`,
    `- **Verdict:** \`${row?.verdict ?? "pending"}\` — a run does not unblock anything by existing.`,
    "- **Reviewed by:** _unreviewed_",
    "",
    "> To grade this run, a human sets the verdict with their name:",
    "> `experimentsRepo.setVerdict(db, id, { verdict: 'sufficient' | 'insufficient', reviewed_by, reviewed_at })`.",
    "> A graded verdict without `reviewed_by` is refused.",
    "",
    "## How far to trust this",
    "",
    // Population first: a reader who meets a percentage before learning it came from
    // fixtures has already been misled, whatever the caveats further down say.
    `- **Population:** ${populationLine}`,
    // "excluded from n" is only true when the measure actually excluded them — `coverage`
    // does, `prefix_stability` counts every session it reduced. Claiming the exclusion
    // either way would misstate what the band was computed over.
    `- **Sample size (n):** ${sampleSizeLine(result)}`,
    `- **Error band:** ${result?.error?.band ?? "unavailable"} — _${result?.error?.basis ?? "no basis stated"}_`,
    `- **Evidence provenance:** ${synthetic ? "**synthetic fixtures are present in this population**" : "no synthetic marker in the population"}`,
  ];

  const notes = result?.notes ?? [];
  if (notes.length) {
    lines.push("", "### Caveats recorded by the measure", "");
    for (const note of notes) lines.push(`- ${note}`);
  }

  lines.push("", "## Detail", "", detailFor(result), "", "## Inputs", "", fence(inputs), "", "## Raw result", "", fence(result), "");
  return lines.join("\n");
}

export default renderReport;
