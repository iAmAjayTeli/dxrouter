/**
 * A deliberately tiny YAML reader.
 *
 * The pricing records must be human-editable and human-auditable, which means a text
 * format; and they must load with no new dependency, because a router that cannot
 * start without a YAML package on npm is worse than one that reads a flat subset
 * itself. So this parses exactly the subset the pricing files use and rejects
 * everything else *with a line number*, rather than guessing:
 *
 *   # comment
 *   key: value            scalars: string, integer, float, true/false, null/~
 *   key: "quoted: value"  double- or single-quoted strings
 *   list:
 *     - 1024              block sequence of scalars, two-space indent
 *
 * No nesting, no anchors, no multi-line scalars, no flow maps. If a future record
 * needs one of those, the honest move is to widen this parser on purpose (and its
 * tests) rather than to discover at runtime that a real YAML engine would have read
 * the file differently from this one.
 *
 * Errors carry `line` so the section 9.3 "malformed" path can report a parse detail an
 * operator can act on.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
    this.code = "PRICING_YAML_PARSE";
    this.line = line;
  }
}

const UNQUOTED_FORBIDDEN = /[:#]\s|^[[{&*!|>%@`]/;

/** Scalar coercion. Order matters: `null` and booleans before numbers before strings. */
function scalar(raw, line) {
  const text = raw.trim();
  if (text === "" || text === "null" || text === "~") return null;

  if (text.length >= 2) {
    const q = text[0];
    if ((q === '"' || q === "'") && text.endsWith(q)) {
      const inner = text.slice(1, -1);
      if (inner.includes(q)) throw new YamlError(`unescaped ${q} inside a quoted scalar`, line);
      return inner;
    }
  }

  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  if (UNQUOTED_FORBIDDEN.test(text)) throw new YamlError("unsupported YAML syntax in a scalar; quote it", line);
  return text;
}

/** Strip a trailing `# comment` that is not inside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * @param {string} text
 * @returns {Record<string, any>} a plain object; keys appear once
 * @throws {YamlError}
 */
export function parseFlatYaml(text) {
  if (typeof text !== "string") throw new YamlError("input must be a string", 0);
  const out = {};
  const lines = text.split(/\r?\n/);
  let listKey = null;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const rawLine = stripComment(lines[i]);
    if (!rawLine.trim()) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const body = rawLine.trim();

    if (body.startsWith("- ") || body === "-") {
      if (!listKey) throw new YamlError("sequence item outside a key", lineNo);
      if (indent === 0) throw new YamlError("sequence items must be indented under their key", lineNo);
      out[listKey].push(scalar(body.slice(1), lineNo));
      continue;
    }

    if (indent !== 0) throw new YamlError("nested mappings are not supported by this reader", lineNo);

    const colon = body.indexOf(":");
    if (colon <= 0) throw new YamlError("expected `key: value`", lineNo);
    const key = body.slice(0, colon).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new YamlError(`unsupported key ${key}`, lineNo);
    if (Object.hasOwn(out, key)) throw new YamlError(`duplicate key ${key}`, lineNo);

    const rest = body.slice(colon + 1).trim();
    if (rest === "") {
      // Either an explicit null or the head of a block sequence; the next non-empty
      // line decides, so start as a list and collapse below if nothing follows.
      out[key] = [];
      listKey = key;
      continue;
    }
    out[key] = scalar(rest, lineNo);
    listKey = null;
  }

  // A key with an empty body and no items is `null`, not an empty list: "the operator
  // left it blank" and "the operator wrote an empty list" should not read the same.
  for (const [key, value] of Object.entries(out)) {
    if (Array.isArray(value) && value.length === 0) out[key] = null;
  }
  return out;
}

export default parseFlatYaml;
