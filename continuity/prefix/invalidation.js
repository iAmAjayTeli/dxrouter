/**
 * Prefix-ordered invalidation (section 9.1) — recorded, never acted upon.
 *
 * Layers are ordered tools, system, messages. Invalidating a layer invalidates
 * everything behind it:
 *
 *   changed tools    -> tools, system, messages
 *   changed system   -> system, messages
 *   changed messages -> messages only, and only from the divergence point
 *
 * `invalidated` is a CACHE INVALIDATION LIST, not a divergence report, and the
 * difference matters most in the one case where it is easy to misread: a turn whose
 * `tools` layer changed while its message chain continued cleanly records
 * `tools,system,messages`. The `messages` entry there says "the cached blocks behind
 * the tools layer are no longer reusable" — it does NOT say the messages layer
 * diverged. It cannot, because the layers are physically nested in the request and a
 * changed tool definition relocates every byte after it.
 *
 * The messages VERDICT is carried separately and always: `relation` and
 * `divergence_index` on the same turn row (`extension` with a null index is a clean
 * continuation, whatever this list contains). A reader that wants "did the
 * conversation break?" reads those; a reader that wants "what must be re-sent to the
 * provider?" reads this. `changed` sits between the two: it names only the layers whose
 * hash actually moved, so `invalidated` minus `changed` is the set of layers that were
 * invalidated purely by position.
 *
 * M1 writes this down and stops there. No cache entry is created or expired, no
 * cache cost is computed, no route is ranked: that is M2 and later, and inventing it
 * here would be exactly the scope creep the milestone forbids.
 *
 * Pure.
 */

import { PREFIX_LAYERS } from "./hasher.js";

/**
 * @param {{tools_hash?: string|null, system_hash?: string|null, messages_hash?: string|null}} prev
 * @param {{tools_hash?: string|null, system_hash?: string|null, messages_hash?: string|null}} next
 * @returns {{changed: string[], invalidated: string[]}} `changed` = layers whose hash
 *          moved; `invalidated` = those plus every layer behind the frontmost one, i.e.
 *          what a cache must drop. Neither is a statement about message-chain
 *          continuity. Both in tools, system, messages order — never sorted
 *          alphabetically, the order is semantic.
 */
export function invalidatedLayers(prev, next) {
  const changed = [];
  if ((prev?.tools_hash ?? null) !== (next?.tools_hash ?? null)) changed.push("tools");
  if ((prev?.system_hash ?? null) !== (next?.system_hash ?? null)) changed.push("system");
  if ((prev?.messages_hash ?? null) !== (next?.messages_hash ?? null)) changed.push("messages");

  let firstChanged = -1;
  for (let i = 0; i < PREFIX_LAYERS.length; i += 1) {
    if (changed.includes(PREFIX_LAYERS[i])) {
      firstChanged = i;
      break;
    }
  }
  const invalidated = firstChanged === -1 ? [] : PREFIX_LAYERS.slice(firstChanged);
  return { changed, invalidated };
}

/** Persisted form: a comma-joined list in layer order, or an empty string. */
export function serializeLayerList(layers) {
  return Array.isArray(layers) ? layers.join(",") : "";
}

/**
 * Read back what `serializeLayerList` wrote.
 *
 * The inverse lives here rather than in whichever module happens to need it, so there is
 * exactly one representation of an invalidation list: a measure that parsed the column
 * with its own `split` would be a second reader free to drift from the writer, and the
 * drift would be invisible — a mis-parsed layer name simply stops matching and reports a
 * prefix as stable.
 *
 * Unknown names are dropped rather than passed through: `PREFIX_LAYERS` is exhaustive, so
 * anything else is corruption, and counting it as a layer would invent instability. The
 * result is returned in semantic layer order regardless of the order it was stored in.
 *
 * @param {string|null|undefined} raw the stored column value
 * @returns {string[]} layer names, tools/system/messages order
 */
export function parseLayerList(raw) {
  if (Array.isArray(raw)) return PREFIX_LAYERS.filter((l) => raw.includes(l));
  if (typeof raw !== "string" || raw.length === 0) return [];
  const seen = new Set(raw.split(",").map((s) => s.trim()));
  return PREFIX_LAYERS.filter((layer) => seen.has(layer));
}

export default invalidatedLayers;
