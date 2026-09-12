/**
 * `dxrouter sessions` — the inspection surface for M1 (§13).
 *
 * Formatting only, and inspection only. This module reads the continuity store and
 * turns rows into text; it cannot pin a route, switch a provider, close a session or
 * change a policy, and §13 forbids adding a command that could. The CLI is how an
 * operator checks whether identity inference is behaving on their own traffic — which
 * is the whole point of an observation milestone — so the numbers it prints have to be
 * the persisted ones, never recomputed for display.
 *
 * Pure with respect to time and locale: `now` is injected and timestamps render as
 * ISO-8601 UTC, so the same database always produces the same text. No `Date.now()`,
 * no locale strings, no colour codes — the output is meant to survive a pipe.
 *
 * Privacy (§14.2): when a session stored a hashed project root, the hash is what gets
 * printed, marked so nobody mistakes it for a path. There is nothing to reverse here;
 * the salt never enters this module.
 */

/** The §13 column set, in display order. */
export const SESSION_COLUMNS = Object.freeze([
  "SESSION",
  "PROJECT",
  "CONF",
  "SOURCE",
  "OPENED",
  "LAST SEEN",
  "TURNS",
  "STATE",
  "PIN",
  "CLOSE REASON",
]);

const HASHED_ROOT_PREFIX = "pr1:";

/** ISO-8601 UTC to seconds. Empty string for a missing timestamp, never "1970". */
export function formatInstant(at) {
  if (!Number.isFinite(at)) return "-";
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Coarse age, for the human column. Injected `now` keeps it testable. */
export function formatAge(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "-";
  const ms = Math.max(0, now - at);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Project root as it may be shown. A hashed root is truncated for width but keeps its
 * `pr1:` prefix, because "this is a hash, not a path" is the part an operator needs.
 */
export function formatProjectRoot(root, hashed, { width = 28 } = {}) {
  const value = typeof root === "string" && root ? root : "unknown";
  const isHash = hashed === 1 || hashed === true || value.startsWith(HASHED_ROOT_PREFIX);
  if (isHash) {
    const digest = value.startsWith(HASHED_ROOT_PREFIX) ? value.slice(HASHED_ROOT_PREFIX.length) : value;
    return `${HASHED_ROOT_PREFIX}${digest.slice(0, 10)}`;
  }
  if (value.length <= width) return value;
  // Keep the tail: the last path segments identify the checkout, the prefix repeats.
  return `...${value.slice(-(width - 3))}`;
}

/** `provider/model` when a pin exists. M1 never sets one; M2 does. */
export function formatPin(session) {
  if (!session?.pin_provider && !session?.pin_model) return "-";
  return [session.pin_provider ?? "?", session.pin_model ?? "?"].join("/");
}

/** One session row, flattened into display-ready primitives. Pure. */
export function describeSession(session, { now = null } = {}) {
  const open = session?.closed_at === null || session?.closed_at === undefined;
  return {
    id: session?.id ?? "",
    project_root: session?.project_root ?? "unknown",
    project_root_hashed: session?.project_root_hashed === 1 || session?.project_root_hashed === true,
    identity_confidence: session?.identity_confidence ?? "unknown",
    identity_source: session?.identity_source ?? "new",
    client_key: session?.client_key ?? null,
    predecessor_id: session?.predecessor_id ?? null,
    opened_at: session?.opened_at ?? null,
    last_seen_at: session?.last_seen_at ?? session?.opened_at ?? null,
    turn_count: session?.turn_count ?? 0,
    state: open ? "open" : "closed",
    closed_at: session?.closed_at ?? null,
    close_reason: session?.close_reason ?? null,
    pin: formatPin(session),
    age: now === null ? null : formatAge(session?.last_seen_at ?? session?.opened_at, now),
  };
}

/** Pad to width; never truncates an id, because a truncated id cannot be looked up. */
function cell(value, width) {
  const s = value === null || value === undefined ? "-" : String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function columnWidths(rows) {
  const w = [
    Math.max(7, ...rows.map((r) => r.id.length)),
    Math.max(7, ...rows.map((r) => r.project_display.length)),
    Math.max(4, ...rows.map((r) => r.identity_confidence.length)),
    Math.max(6, ...rows.map((r) => r.identity_source.length)),
    20,
    Math.max(9, ...rows.map((r) => r.last_seen_display.length)),
    5,
    6,
    Math.max(3, ...rows.map((r) => r.pin.length)),
    Math.max(12, ...rows.map((r) => (r.close_reason ?? "-").length)),
  ];
  return w;
}

/**
 * The table form. Deterministic given the same rows and `now`; column widths are
 * derived from the data so nothing is silently clipped except an over-long project
 * path, which `formatProjectRoot` shortens on purpose.
 */
export function renderSessionsTable(sessions, { now = null, rootWidth = 28 } = {}) {
  const rows = sessions.map((s) => {
    const d = describeSession(s, { now });
    return {
      ...d,
      project_display: formatProjectRoot(d.project_root, d.project_root_hashed, { width: rootWidth }),
      last_seen_display: d.age ? `${formatInstant(d.last_seen_at)} (${d.age})` : formatInstant(d.last_seen_at),
    };
  });

  if (rows.length === 0) {
    return "no sessions recorded";
  }

  const w = columnWidths(rows);
  const header = SESSION_COLUMNS.map((c, i) => cell(c, w[i])).join("  ").trimEnd();
  const lines = [header, w.map((n) => "-".repeat(n)).join("  ").trimEnd()];
  for (const r of rows) {
    lines.push(
      [
        cell(r.id, w[0]),
        cell(r.project_display, w[1]),
        cell(r.identity_confidence, w[2]),
        cell(r.identity_source, w[3]),
        cell(formatInstant(r.opened_at), w[4]),
        cell(r.last_seen_display, w[5]),
        cell(r.turn_count, w[6]),
        cell(r.state, w[7]),
        cell(r.pin, w[8]),
        cell(r.close_reason ?? "-", w[9]),
      ]
        .join("  ")
        .trimEnd(),
    );
  }
  return lines.join("\n");
}

/** The machine form. Same fields, no formatting decisions baked in. */
export function renderSessionsJson(sessions, { now = null, pretty = true } = {}) {
  const payload = { generated_at: now, count: sessions.length, sessions: sessions.map((s) => describeSession(s, { now })) };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

/**
 * Per-turn detail for one session: `dxrouter sessions <id>`. Hashes are shortened for
 * reading; the full value is in the JSON form, since a truncated hash is useless for
 * comparing two sessions by hand.
 */
export function renderSessionDetail(session, turns = [], { now = null } = {}) {
  if (!session) return "session not found";
  const d = describeSession(session, { now });
  const short = (h) => (typeof h === "string" && h.length > 14 ? `${h.slice(0, 14)}...` : (h ?? "-"));
  const head = [
    `session       ${d.id}`,
    `project       ${d.project_root}${d.project_root_hashed ? "  (hashed)" : ""}`,
    `identity      ${d.identity_confidence} via ${d.identity_source}`,
    `client key    ${d.client_key ?? "-"}`,
    `predecessor   ${d.predecessor_id ?? "-"}`,
    `opened        ${formatInstant(d.opened_at)}`,
    `last seen     ${formatInstant(d.last_seen_at)}${d.age ? `  (${d.age} ago)` : ""}`,
    `turns         ${d.turn_count}`,
    `state         ${d.state}${d.close_reason ? `  (${d.close_reason})` : ""}`,
    `pin           ${d.pin}`,
  ];
  if (turns.length === 0) return head.join("\n");

  const rows = turns.map((t) => [
    String(t.idx),
    formatInstant(t.at),
    `${t.identity_confidence ?? "-"}/${t.identity_source ?? "-"}`,
    t.relation ?? "-",
    `${t.message_count ?? "-"}m`,
    `t=${t.tools_tokens ?? "-"} s=${t.system_tokens ?? "-"} m=${t.messages_tokens ?? "-"} (${t.messages_tokens_provenance ?? "-"})`,
    short(t.messages_hash),
    t.boundary ?? "",
    t.labels ?? "",
  ]);
  const heads = ["IDX", "AT", "IDENTITY", "RELATION", "MSGS", "TOKENS", "MESSAGES HASH", "BOUNDARY", "LABELS"];
  const w = heads.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const lines = [
    ...head,
    "",
    heads.map((h, i) => cell(h, w[i])).join("  ").trimEnd(),
    w.map((n) => "-".repeat(n)).join("  ").trimEnd(),
    ...rows.map((r) => r.map((v, i) => cell(v, w[i])).join("  ").trimEnd()),
  ];
  return lines.join("\n");
}

/**
 * Query + render in one call, for a host CLI that has a store handle.
 *
 * Reads only. The store is passed in rather than opened here: opening a database is
 * host knowledge (a data root, a driver choice), and I1 keeps both out of this tree.
 *
 * @param {object} args
 * @param {object} args.store output of openContinuityStore
 * @param {{now: () => number}} [args.clock]
 * @param {object} [args.options] `{id, all, project, limit, json, turns}`
 * @returns {{text: string, count: number}}
 */
export function renderSessionsView({ store, clock = null, options = {} } = {}) {
  const { db, sessions, turns } = store;
  const now = clock ? clock.now() : null;

  if (options.id) {
    const session = sessions.getSession(db, options.id);
    if (options.json) {
      const rows = session ? turns.listTurns(db, options.id, { limit: options.turns ?? 200 }) : [];
      return {
        text: JSON.stringify(
          { generated_at: now, session: session ? describeSession(session, { now }) : null, turns: rows },
          null,
          2,
        ),
        count: session ? 1 : 0,
      };
    }
    const rows = session ? turns.listTurns(db, options.id, { limit: options.turns ?? 200 }) : [];
    return { text: renderSessionDetail(session, rows, { now }), count: session ? 1 : 0 };
  }

  const list = sessions.listSessions(db, {
    includeClosed: options.all !== false,
    projectRoot: options.project ?? null,
    limit: Number.isFinite(options.limit) ? options.limit : 50,
  });
  return {
    text: options.json ? renderSessionsJson(list, { now }) : renderSessionsTable(list, { now }),
    count: list.length,
  };
}

export default renderSessionsView;
