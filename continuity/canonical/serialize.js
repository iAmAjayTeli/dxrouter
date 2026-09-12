/**
 * Canonical serialization (canon version "c1") — the one place bytes are decided.
 *
 * FINAL-ARCHITECTURE.md v1.1 section 10.3 defines this contract for Decision
 * hashing. M1 does not produce Decisions, but it does produce prefix-layer hashes,
 * and those have to obey the same rules: two logically identical layers must
 * produce identical bytes on any machine, in any process, in any key order.
 *
 * The rules implemented here, in the wording of section 10.3:
 *  - UTF-8, no BOM; JSON subset only; NaN and Infinity are a serialization error,
 *    not a value.
 *  - Object keys ascend byte-wise by UTF-8 key bytes, applied recursively. Not
 *    locale collation, not insertion order.
 *  - Absent and null are distinct: an absent field is omitted, null is emitted.
 *  - Semantically ordered arrays keep their order. (Layer arrays are ordered
 *    tools, system, messages; message arrays are ordered by the client. Nothing
 *    here re-sorts an array, because nothing here knows which arrays are set-like.)
 *  - Strings are NFC-normalized, escaping restricted to the minimal JSON set.
 *  - Hash is SHA-256 of the canonical bytes, lowercase hex, prefixed with the canon
 *    version. Truncation is prohibited.
 *
 * Deliberate M1 note on floats: section 10.3 forbids floating point *in a
 * Decision*, where every quantity is an integer by construction (micro-USD, basis
 * points, integer ms). A prefix layer is not a Decision — it is whatever JSON the
 * client sent, and a client may legitimately send 0.7. Rejecting it would make the
 * hasher unusable, so a finite non-integer serializes through the ECMAScript
 * Number-to-String algorithm, which is specified exactly and therefore identical on
 * every conforming runtime. No float is ever *computed* here.
 *
 * Pure: imports node:crypto and nothing else. No clock, no environment, no state.
 */

import { createHash } from "node:crypto";

/** Canon version. Changing serialization rules means changing this string. */
export const CANON_VERSION = "c1";

/** Guard against pathological nesting; a real request body is a handful deep. */
const MAX_DEPTH = 200;

export class CanonicalizationError extends Error {
  constructor(message, { code = "CANON_INVALID_VALUE", path = "" } = {}) {
    super(path ? `${message} (at ${path || "$"})` : message);
    this.name = "CanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

/** Byte-wise ascending comparison of two keys, per section 10.3. */
export function compareKeysByBytes(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function serializeString(str) {
  // JSON.stringify already emits exactly the minimal escape set (quote, reverse
  // solidus, controls below 0x20 as lowercase \u00xx), never escapes the solidus,
  // and is specified precisely enough to be identical across runtimes.
  return JSON.stringify(str.normalize("NFC"));
}

function serializeNumber(value, path) {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`non-finite number is not serializable: ${value}`, {
      code: "CANON_NON_FINITE",
      path,
    });
  }
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function walk(value, depth, seen, path) {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError("value nests deeper than the canonical limit", {
      code: "CANON_TOO_DEEP",
      path,
    });
  }

  if (value === null) return "null";

  const t = typeof value;
  if (t === "string") return serializeString(value);
  if (t === "number") return serializeNumber(value, path);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "bigint") {
    throw new CanonicalizationError("bigint is not part of the JSON subset", {
      code: "CANON_UNSUPPORTED_TYPE",
      path,
    });
  }

  if (seen.has(value)) {
    throw new CanonicalizationError("value contains a cycle", { code: "CANON_CYCLE", path });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item, i) => {
        const out = walk(item, depth + 1, seen, `${path}[${i}]`);
        // JSON semantics: a hole or an undefined element is null inside an array.
        return out === undefined ? "null" : out;
      });
      return `[${parts.join(",")}]`;
    }

    if (typeof value.toJSON === "function") {
      return walk(value.toJSON(), depth + 1, seen, path);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(
        `only plain objects are part of the JSON subset, got ${value?.constructor?.name || "object"}`,
        { code: "CANON_UNSUPPORTED_TYPE", path }
      );
    }

    const keys = Object.keys(value).sort(compareKeysByBytes);
    const parts = [];
    for (const key of keys) {
      const out = walk(value[key], depth + 1, seen, `${path}.${key}`);
      // Absent stays absent: an undefined property is omitted, not emitted as null.
      if (out === undefined) continue;
      parts.push(`${serializeString(key)}:${out}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Canonical JSON text for `value`.
 * @throws {CanonicalizationError} on a cycle, a non-finite number, a bigint, or a
 *         class instance that is not plain JSON.
 */
export function canonicalize(value) {
  const out = walk(value, 0, new Set(), "$");
  if (out === undefined) {
    throw new CanonicalizationError("top-level value is not serializable", {
      code: "CANON_UNSUPPORTED_TYPE",
      path: "$",
    });
  }
  return out;
}

/** Canonical UTF-8 bytes for `value`. No BOM. */
export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

/** Lowercase hex SHA-256 of a string or buffer. Never truncated. */
export function sha256Hex(input) {
  return createHash("sha256").update(typeof input === "string" ? Buffer.from(input, "utf8") : input).digest("hex");
}

/** Version-prefixed digest of the canonical bytes of `value`: "c1:<64 hex>". */
export function digest(value) {
  return `${CANON_VERSION}:${sha256Hex(canonicalBytes(value))}`;
}

/** True for a well-formed version-prefixed digest produced by this module. */
export function isDigest(str) {
  return typeof str === "string" && /^c1:[0-9a-f]{64}$/.test(str);
}

export default digest;
