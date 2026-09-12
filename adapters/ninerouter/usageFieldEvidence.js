/**
 * `usageFieldEvidence` — what a provider's usage object actually looked like (I-8).
 *
 * Every claim in `usageFields.js` about how a vendor spells its cache counts is currently
 * evidence-free: it was read from documentation and from this repository's own translators.
 * When a field is missing from that table the failure is silent — the observer records
 * `null`, the coverage measure reports a silent provider, and nothing anywhere says
 * "there was a number here and we did not read it". This file is the only artefact that
 * can settle such a question after the fact.
 *
 * Four properties make it safe to ship:
 *
 *  1. **Off by default.** `DXR_USAGE_FIELD_EVIDENCE=1` is the only way to turn it on, and
 *     the flag resolves through the same `continuity/flags.js` surface as every other
 *     switch, so `describeFlags` can say it is on.
 *  2. **Numbers and shapes only.** A leaf is kept only if it is a finite number or a
 *     boolean. Strings — model names, ids, anything a prompt could reach — are replaced by
 *     `"<string>"`. There is no code path here that can write a token, a body or a name.
 *  3. **One sample per field signature.** The signature is the sorted list of key paths, so
 *     a provider that always reports the same shape writes one record ever. New shapes are
 *     the interesting event; repeated shapes are noise, and an unbounded file on the
 *     response path is a disk-usage bug waiting to happen.
 *  4. **Fail-open and never on the critical path.** Every entry point swallows its own
 *     errors. The caller already treats observation as best-effort; this must not be the
 *     thing that breaks that promise.
 *
 * The samples land in `<data root>/evidence/usage-fields/<provider>.json`, mode 0600,
 * beside the measurement reports they support. Nothing uploads them.
 */

import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "../../src/lib/dataDir.js";
import { redactSecrets } from "../../src/lib/security/redact.js";
import { resolveFlags } from "../../continuity/flags.js";

/** `<data root>/evidence/usage-fields/` — kept in step with `src/lib/dataDir.js`, one root. */
export const USAGE_FIELD_DIR = path.join(DATA_DIR, "evidence", "usage-fields");

/** Enough shapes to catch a provider that varies, few enough to stay a diagnostic. */
export const MAX_SIGNATURES_PER_PROVIDER = 8;

/** Depth limit: real usage objects nest one level (`prompt_tokens_details`). */
const MAX_DEPTH = 4;

/** Whether an operator asked for raw usage samples at all. */
export function usageFieldEvidenceEnabled(env = process.env) {
  return resolveFlags(env).usageFieldEvidence === true;
}

/**
 * Reduce a usage object to numbers, booleans and shape markers.
 *
 * The point of the type markers is that a *missing* spelling and a spelling whose value is
 * a string look different in the record: the first is absent, the second is `"<string>"`.
 */
export function skeleton(value, depth = 0) {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : "<number:nonfinite>";
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return "<string>";
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? "<array>" : value.slice(0, 4).map((v) => skeleton(v, depth + 1));
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "<object>";
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, 40)) out[key] = skeleton(value[key], depth + 1);
    return out;
  }
  return `<${typeof value}>`;
}

/** Sorted key paths of a usage object: the identity of a provider's usage *shape*. */
export function fieldSignature(value, prefix = "", depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth >= MAX_DEPTH) return [];
  const paths = [];
  for (const key of Object.keys(value).sort()) {
    const at = prefix ? `${prefix}.${key}` : key;
    paths.push(at);
    paths.push(...fieldSignature(value[key], at, depth + 1));
  }
  return paths;
}

/** One file per provider; the alias is confined to a filename-safe token. */
function fileFor(provider, dir) {
  const safe = String(provider || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60) || "unknown";
  return path.join(dir, `${safe}.json`);
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.samples) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record one raw usage sample, if this shape has not been seen for this provider.
 *
 * @param {object} args
 * @param {string|null} args.provider the 9Router alias, as the route named it
 * @param {object|null} args.usage the provider's usage object, exactly as it arrived
 * @param {object} [args.env]
 * @param {string} [args.dir] override, for tests that must not touch the real root
 * @param {number} [args.at] epoch ms; the caller's clock, not this module's
 * @returns {{recorded: boolean, reason?: string, signature?: string, file?: string}}
 */
export function recordUsageFields({ provider, usage, env = process.env, dir = USAGE_FIELD_DIR, at = null } = {}) {
  try {
    if (!usageFieldEvidenceEnabled(env)) return { recorded: false, reason: "disabled" };
    if (!usage || typeof usage !== "object") return { recorded: false, reason: "no_usage" };
    const raw = usage.usage && typeof usage.usage === "object" ? usage.usage : usage;
    const paths = fieldSignature(raw);
    if (!paths.length) return { recorded: false, reason: "no_fields" };
    const signature = paths.join(",");

    const file = fileFor(provider, dir);
    const record = readRecord(file) ?? { provider: provider ?? null, samples: [] };
    if (record.samples.some((s) => s.signature === signature)) return { recorded: false, reason: "shape_already_recorded", signature, file };
    if (record.samples.length >= MAX_SIGNATURES_PER_PROVIDER) return { recorded: false, reason: "sample_cap_reached", signature, file };

    record.provider = provider ?? record.provider ?? null;
    record.samples.push({
      // `at` comes from the caller so this module reads no clock; a sample with no time is
      // still evidence about a field name, which is what it is for.
      at: Number.isFinite(at) ? at : null,
      signature,
      fields: paths,
      // Redaction on top of the numbers-only reduction. Belt and braces on purpose: this
      // writes to disk from the response path, and the reduction is the kind of code that
      // acquires an exception later.
      sample: redactSecrets(skeleton(raw), { drop: true }),
    });

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { recorded: true, signature, file };
  } catch (e) {
    // Never the reason a completion fails, and never the reason an observation is lost.
    return { recorded: false, reason: "error", error: e?.message || String(e) };
  }
}

export default recordUsageFields;
