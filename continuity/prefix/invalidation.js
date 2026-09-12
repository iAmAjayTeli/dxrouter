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
 * @returns {{changed: string[], invalidated: string[]}} both in tools, system,
 *          messages order — never sorted alphabetically, the order is semantic
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
