/**
 * PrefixHasher — three independent layer hashes, never one whole-request hash.
 *
 * Section 9.1: layers are ordered tools, system, messages, and invalidating one
 * invalidates everything behind it. A single hash over the whole request cannot
 * express that ordering, so it is prohibited. Each layer therefore gets its own
 * digest over its own canonical bytes, and a change in one layer provably cannot
 * move another layer hash.
 *
 * The messages layer additionally gets a digest *chain*, because the interesting
 * question about messages is not "did they change" but "are the new messages an
 * extension of the old ones":
 *
 *   D_i    = digest(message_i)                 per-message digest
 *   H_0    = digest([])                        the empty sequence
 *   H_i    = digest([H_(i-1), D_i])            rolling chain
 *   hash   = H_n                               the messages layer hash
 *
 * H_k is the hash of exactly the first k messages, so "is the new sequence an
 * extension of a previous sequence of length k" reduces to one string comparison
 * (see prefix/extension.js). Nothing about message *count* alone is ever used as
 * evidence, and no message content is retained: a digest is one-way, which is what
 * lets a session be tracked without storing a prompt (section 14).
 *
 * Pure: canonical serialization and nothing else. No clock, no environment.
 */

import { digest } from "../canonical/serialize.js";
import { PREFIX_RULE_VERSION, bookkeepingDigest } from "./bookkeeping.js";
import { countLayerTokens } from "./tokens.js";

/** Ordered layer names. The order is semantic (section 9.1), never sorted. */
export const PREFIX_LAYERS = Object.freeze(["tools", "system", "messages"]);

/** Digest of the empty message sequence: the chain root. */
export const EMPTY_CHAIN_ROOT = digest([]);

function absent(value) {
  return value === null || value === undefined;
}

/** Layer hash for the tools layer, or null when the request carries no tools. */
export function hashToolsLayer(tools) {
  return absent(tools) ? null : digest(tools);
}

/** Layer hash for the system layer, or null when the request carries no system. */
export function hashSystemLayer(system) {
  return absent(system) ? null : digest(system);
}

/** Per-message digests, in the order the client sent them. */
export function messageDigests(messages) {
  if (absent(messages)) return null;
  if (!Array.isArray(messages)) return [digest(messages)];
  return messages.map((m) => digest(m));
}

/**
 * Rolling chain over per-message digests.
 * @returns {string[]} length is digests.length + 1; index k is the hash of the
 *          first k messages, so index 0 is the empty-sequence root.
 */
export function chainFromDigests(digests) {
  const chain = [EMPTY_CHAIN_ROOT];
  for (const d of digests) chain.push(digest([chain[chain.length - 1], d]));
  return chain;
}

/**
 * Hash the messages layer.
 *
 * Every hash here is strict: the canonical digest of exactly what the client sent.
 * Two extra fields exist for the bounded cache-bookkeeping re-test in
 * `prefix/extension.js`, and neither of them changes a strict hash:
 *
 *  - `final_digest_norm` is the last message's digest under `PREFIX_RULE_VERSION`
 *    (bookkeeping fields removed). It is the one value the *next* request needs in
 *    order to re-test the boundary, so it is computed eagerly and persisted — exactly
 *    one extra message digest per turn, no second digest chain.
 *  - `normalized_digest_at(i)` computes the same thing for any index, on demand and
 *    memoised. Nothing calls it unless the strict test has already failed at the one
 *    boundary index, so the normal path pays nothing for it.
 *
 * @returns {{hash: string|null, count: number|null, digests: string[]|null,
 *            chain: string[]|null, final_digest_norm: string|null,
 *            prefix_rule_version: string, normalized_digest_at: (i: number) => string|null}}
 */
export function hashMessagesLayer(messages) {
  const digests = messageDigests(messages);
  if (digests === null) {
    return {
      hash: null,
      count: null,
      digests: null,
      chain: null,
      final_digest_norm: null,
      prefix_rule_version: PREFIX_RULE_VERSION,
      normalized_digest_at: () => null,
    };
  }
  const list = Array.isArray(messages) ? messages : [messages];
  const chain = chainFromDigests(digests);
  const memo = new Map();
  const normalizedDigestAt = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return null;
    if (!memo.has(i)) memo.set(i, bookkeepingDigest(list[i]));
    return memo.get(i);
  };
  return {
    hash: chain[chain.length - 1],
    count: digests.length,
    digests,
    chain,
    final_digest_norm: list.length ? normalizedDigestAt(list.length - 1) : null,
    prefix_rule_version: PREFIX_RULE_VERSION,
    normalized_digest_at: normalizedDigestAt,
  };
}

/**
 * Compute all three layers with token counts and provenance.
 *
 * @param {{tools?: *, system?: *, messages?: *}} request the three layers only —
 *        deliberately not a whole NormalizedRequest, so nothing else can leak into
 *        a layer hash
 * @param {object} [opts]
 * @param {Function} [opts.tokenizer] see prefix/tokens.js
 * @returns {{tools: object, system: object, messages: object}}
 */
export function computePrefixLayers({ tools, system, messages } = {}, { tokenizer = null } = {}) {
  const toolsTokens = countLayerTokens(absent(tools) ? null : tools, { tokenizer });
  const systemTokens = countLayerTokens(absent(system) ? null : system, { tokenizer });
  const messagesTokens = countLayerTokens(absent(messages) ? null : messages, { tokenizer });
  const msg = hashMessagesLayer(messages);

  return {
    tools: { hash: hashToolsLayer(tools), ...toolsTokens },
    system: { hash: hashSystemLayer(system), ...systemTokens },
    messages: {
      hash: msg.hash,
      count: msg.count,
      digests: msg.digests,
      chain: msg.chain,
      final_digest_norm: msg.final_digest_norm,
      prefix_rule_version: msg.prefix_rule_version,
      normalized_digest_at: msg.normalized_digest_at,
      ...messagesTokens,
    },
  };
}

/**
 * The persisted, content-free projection of a layer set: hashes, counts and
 * provenance. What goes in a `turns` row.
 */
export function prefixLayerSummary(layers) {
  return {
    tools_hash: layers.tools.hash,
    system_hash: layers.system.hash,
    messages_hash: layers.messages.hash,
    message_count: layers.messages.count,
    tools_tokens: layers.tools.tokens,
    system_tokens: layers.system.tokens,
    messages_tokens: layers.messages.tokens,
    tools_tokens_provenance: layers.tools.provenance,
    system_tokens_provenance: layers.system.provenance,
    messages_tokens_provenance: layers.messages.provenance,
  };
}

export default computePrefixLayers;
