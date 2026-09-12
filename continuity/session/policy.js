/**
 * Session policy — every tunable in one injected place.
 *
 * Some of these numbers are fixed by FINAL-ARCHITECTURE.md v1.1 and some are not.
 * Keeping them together makes the difference visible instead of burying an invented
 * constant in a branch somewhere:
 *
 *   lockStaleMs            60000   section 12.2, fixed by the document
 *   lockAcquireBudgetMs      250   section 12.2, fixed by the document
 *   turnRetentionDays         30   section 12.3, fixed by the document
 *   idleTimeoutMs        1800000   NOT in the document. The 5 minute figure there is
 *                                  a provider cache TTL, not a session idle timeout.
 *                                  30 minutes is this implementation choice and is
 *                                  reported as a deviation.
 *   compactionShrinkMaxBp   9000   NOT in the document. Section 5 defines the
 *                                  compaction signature qualitatively (shortens the
 *                                  total token count); materially shorter needs a
 *                                  number, and 90 percent of the previous count is it.
 *   maxChainMessages        5000   storage bound for the per-session digest chain.
 *                                  Beyond it the prefix question becomes honestly
 *                                  unanswerable (indeterminate), which is a defined
 *                                  outcome rather than a guess.
 *
 * Ratios are integers in basis points (10^-4) per section 10.3: no float ever takes
 * part in a comparison that decides a session boundary.
 *
 * Pure.
 */

export const DEFAULT_SESSION_POLICY = Object.freeze({
  idleTimeoutMs: 30 * 60 * 1000,
  compactionShrinkMaxBp: 9000,
  lockStaleMs: 60 * 1000,
  lockAcquireBudgetMs: 250,
  lockRetryDelayMs: 25,
  turnRetentionDays: 30,
  sessionRetentionDays: 30,
  maxChainMessages: 5000,
  sweepIntervalMs: 60 * 60 * 1000,
});

const INTEGER_KEYS = Object.keys(DEFAULT_SESSION_POLICY);

function positiveInt(value, fallback) {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/**
 * Merge overrides onto the defaults, rejecting anything that is not a positive
 * integer. An unparseable override falls back to the default rather than disabling a
 * safety window by accident.
 *
 * @param {object} [overrides]
 * @returns {Readonly<object>}
 */
export function resolveSessionPolicy(overrides = {}) {
  const out = {};
  for (const key of INTEGER_KEYS) {
    out[key] = positiveInt(overrides?.[key], DEFAULT_SESSION_POLICY[key]);
  }
  // A shrink threshold above 100 percent would call every unchanged prefix a compaction.
  if (out.compactionShrinkMaxBp > 10000) out.compactionShrinkMaxBp = DEFAULT_SESSION_POLICY.compactionShrinkMaxBp;
  return Object.freeze(out);
}

export default resolveSessionPolicy;
