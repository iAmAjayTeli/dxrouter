/**
 * Cache-bookkeeping normalization for the prefix boundary re-test (rule "r1").
 *
 * A measured fact about one real client, not a heuristic. Claude Code marks the
 * message it wants the provider to cache by putting `cache_control` on a content
 * block of the *newest* message, and it removes that marker from the message that
 * was newest a moment ago. The bytes of the message do not otherwise change: the
 * captured bodies show the identical `tool_result` block (same `tool_use_id`, same
 * 17026-byte content, same content hash) appearing first with `cache_control` and
 * then without it. The digests are equal once that one field is dropped.
 *
 * ### Why the tolerated window is two messages wide (rule "r2")
 *
 * A later capture of six consecutive requests from one Claude Code stream-json
 * conversation measured the same client keeping **two** rolling breakpoints, not one:
 * one on the newest assistant block and one on the newest `tool_result`. When both
 * roll forward, both previously-marked messages lose their marker in the same request.
 * In the router's projected messages layer (role=system/developer excluded, see
 * `adapters/ninerouter/normalizeAdapter.js`) that shows up as the final TWO positions
 * changing together — offsets 0 and 1 from the previous array's end — while everything
 * before them stays byte-identical.
 *
 * Measured, per-request, across that capture (projected counts 1,3,5,7,9,11):
 *
 *   pair 1->2  clean extension
 *   pair 2->3  offset [1]      messages[1].content[0].cache_control removed  (assistant)
 *   pair 3->4  offset [1]      messages[3].content[0].cache_control removed  (assistant)
 *   pair 4->5  offset [1]      messages[5].content[0].cache_control removed  (assistant)
 *   pair 5->6  offsets [0,1]   messages[7] (assistant) AND messages[8] (tool_result)
 *
 * Every differing JSON path in every pair was exactly `…content[0].cache_control`
 * transitioning `{"type":"ephemeral"}` -> absent. No `thinking`, `signature`,
 * `tool_use.id`, `tool_use_id`, `tool_result` content, `usage`, text, role or shape
 * change accompanied it, and `stripBookkeeping` restored exact digest equality in all
 * six changed messages. Because the first difference is at `prev.count - 2` whenever
 * the assistant is the earlier of the two, r1's single-position guard refused every
 * one of them and split a conversation that never ended.
 *
 * "r2" therefore tolerates the moved breakpoint at `prev.count - 1` OR `prev.count - 2`
 * and requires normalized equality at EVERY position from the divergence through
 * `prev.count - 1`. A divergence at `prev.count - 3` or deeper is still a
 * discontinuity, and a difference inside the window that survives `stripBookkeeping`
 * is still a discontinuity. Nothing else changed: same field list, same canon, same
 * digest equality, no tolerance and no similarity.
 *
 * Under strict canonical hashing (which is correct and stays unchanged) that field
 * moving makes the previously-final message a different message, so the strict
 * prefix test reports a divergence at exactly the previous request's last index and
 * a genuinely continuing conversation is split into two sessions.
 *
 * This module therefore defines ONE thing: the exact, enumerated set of client cache
 * bookkeeping fields, and a digest computed with those fields removed. It is used in
 * one place only (`prefix/extension.js`), only after the strict test has already
 * failed, and only at the one or two boundary indices the rule names. It is not a
 * similarity measure and it cannot become one: `BOOKKEEPING_FIELDS` is a literal field
 * list, the comparison it feeds is digest equality, and there is no tolerance,
 * threshold or distance anywhere in it.
 *
 * `PREFIX_RULE_VERSION` names this rule set. Adding, removing or renaming a field in
 * `BOOKKEEPING_FIELDS` — or changing what `stripBookkeeping` does — MUST bump it, in
 * the same way `CANON_VERSION` governs the serializer. Every persisted prefix
 * observation records the version that was in force, so a stored row can always say
 * which rule produced it. The canonical serializer itself is deliberately untouched:
 * `CANON_VERSION` stays "c1" and every strict hash keeps its exact meaning.
 *
 * Pure: canonical serialization and nothing else.
 */

import { CanonicalizationError, digest } from "../canonical/serialize.js";

/**
 * Version of the bookkeeping-normalization rule below. Recorded on every turn and
 * every prefix state. Bump on any change to the rule.
 *
 * "r1" tolerated a moved breakpoint at exactly `prev.count - 1`. "r2" widens the
 * tolerated position to `prev.count - 1` OR `prev.count - 2` and nothing else; the
 * field list, the canon and the digest-equality test are identical. See the window
 * note at the top of this file and `prefix/extension.js` for the guards.
 */
export const PREFIX_RULE_VERSION = "r2";

/**
 * The complete set of fields treated as client cache bookkeeping, by exact name.
 *
 * `cache_control` is the Anthropic prompt-caching breakpoint marker. It carries no
 * conversation content — it tells the provider where to write a cache entry — and it
 * is the only field the capture showed moving between otherwise identical requests.
 * Nothing else belongs here without new measured evidence.
 */
export const BOOKKEEPING_FIELDS = Object.freeze(["cache_control"]);

const DROP = new Set(BOOKKEEPING_FIELDS);

/** Same limit the serializer enforces, so a pathological value fails the same way. */
const MAX_DEPTH = 200;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural copy with the bookkeeping fields removed at any depth.
 *
 * Deliberately not `JSON.parse(JSON.stringify(...))`: a JSON round-trip also erases
 * the absent/null distinction the canon rules require, which could make two genuinely
 * different messages compare equal — a false continuation. This copies, and the only
 * difference from the input is the named keys.
 *
 * The input is returned unchanged when nothing was dropped, so a message with no
 * bookkeeping field has a normalized digest identical to its strict digest.
 */
function strip(value, depth) {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError("value nests deeper than the canonical limit", {
      code: "CANON_TOO_DEEP",
    });
  }

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const s = strip(item, depth + 1);
      if (s !== item) changed = true;
      return s;
    });
    return changed ? out : value;
  }

  if (!isPlainObject(value)) return value;
  // The serializer hands a `toJSON` object to its own output; stripping inside it
  // would describe something that is never hashed. Left alone.
  if (typeof value.toJSON === "function") return value;

  let changed = false;
  const out = {};
  for (const key of Object.keys(value)) {
    if (DROP.has(key)) {
      changed = true;
      continue;
    }
    const child = strip(value[key], depth + 1);
    if (child !== value[key]) changed = true;
    out[key] = child;
  }
  return changed ? out : value;
}

/** One message with every bookkeeping field removed. */
export function stripBookkeeping(message) {
  return strip(message, 0);
}

/** True when the value carries no bookkeeping field at any depth. */
export function hasBookkeeping(message) {
  return stripBookkeeping(message) !== message;
}

/**
 * Digest of one message under rule `PREFIX_RULE_VERSION`. Same canon, same "c1:"
 * digest space as every other hash here — only the named fields are absent.
 */
export function bookkeepingDigest(message) {
  return digest(stripBookkeeping(message));
}

export default bookkeepingDigest;
