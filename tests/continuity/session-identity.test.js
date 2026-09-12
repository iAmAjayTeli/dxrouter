/**
 * Group A — session identity and confidence (§14 A, §§2-4).
 *
 * Two halves, on purpose. The first drives the pure `resolveSessionIdentity` with
 * hand-built candidates, because that is where every safety branch lives and a unit
 * test can name the branch it is exercising. The second drives `observeTurn` against
 * a real database, because "explicit overrides inference" is only true if the *store
 * lookup* also prefers the key — a resolver that is right about a candidate list it
 * was handed proves nothing about which candidates it is handed.
 *
 * The rule under test throughout: FALSE SPLIT beats FALSE CONTINUATION. Every
 * ambiguous case must end at a new session graded `unknown`, never at a guess.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  RESOLUTION_ACTION,
  layersToPrefixState,
  resolveSessionIdentity,
} from "../../continuity/identity/sessionResolver.js";
import { IDENTITY_CONFIDENCE, IDENTITY_SOURCE, M1_LABELS } from "../../continuity/identity/confidence.js";
import {
  MAX_SESSION_KEY_LENGTH,
  SESSION_KEY_REJECTION,
  validateSessionKey,
} from "../../continuity/identity/sessionId.js";
import { computePrefixLayers } from "../../continuity/prefix/hasher.js";
import { MESSAGE_RELATION } from "../../continuity/prefix/extension.js";
import { CLOSE_REASON } from "../../continuity/session/lifecycle.js";
import { SYSTEM, TOOLS, messages, openHarness, removeTmpDir, turnRequest } from "./helpers/harness.js";

const layersFor = (msgs, { tools = TOOLS, system = SYSTEM } = {}) =>
  computePrefixLayers({ tools, system, messages: msgs });

/** A stored candidate whose recorded prefix state is the given message list. */
const candidateFor = (id, msgs, extra = {}) => ({
  session: { id, client_key: null, ...extra },
  prefix: layersToPrefixState(layersFor(msgs)),
});

/** Blind a candidate: tools+system recorded, messages layer absent (the weak row). */
const blindCandidate = (id) => {
  const c = candidateFor(id, messages(2));
  c.prefix.messages_hash = null;
  c.prefix.message_count = null;
  c.prefix.digests = null;
  c.prefix.chain = null;
  return c;
};

describe("A1 — the four confidence levels are all reachable", () => {
  it("explicit: a validated key names the identity outright", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(3)),
      explicitKey: "cc-abc",
      explicitCandidate: candidateFor("s1", messages(1)),
    });
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(r.source).toBe(IDENTITY_SOURCE.HEADER);
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
    expect(r.session_id).toBe("s1");
  });

  it("strongly_inferred: one candidate, proven prefix extension", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(3)),
      candidates: [candidateFor("s1", messages(1))],
    });
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(r.source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
    expect(r.relation).toBe(MESSAGE_RELATION.EXTENSION);
    expect(r.session_id).toBe("s1");
  });

  it("weakly_inferred: tools+system continuous, messages undecidable", () => {
    // The recorded candidate has no messages layer at all, so the extension proof
    // cannot run either way. Section 4.2 weak row: name the session, weakest grade.
    const r = resolveSessionIdentity({ layers: layersFor(messages(4)), candidates: [blindCandidate("s1")] });
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.WEAKLY_INFERRED);
    expect(r.source).toBe(IDENTITY_SOURCE.AMBIGUOUS_PREFIX);
    expect(r.relation).toBe(MESSAGE_RELATION.INDETERMINATE);
    expect(r.action).toBe(RESOLUTION_ACTION.CONTINUE);
  });

  it("unknown: no evidence at all is a new session, not a failure", () => {
    const r = resolveSessionIdentity({ layers: layersFor(messages(1)), candidates: [] });
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.source).toBe(IDENTITY_SOURCE.NEW);
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.session_id).toBeNull();
  });
});

describe("A2 — explicit identity takes precedence over inference", () => {
  it("does not consult candidates when a key is present", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(3)),
      explicitKey: "cc-abc",
      explicitCandidate: candidateFor("keyed", messages(1)),
      candidates: [candidateFor("inferred", messages(1))],
    });
    expect(r.session_id).toBe("keyed");
    expect(r.source).toBe(IDENTITY_SOURCE.HEADER);
  });

  it("opens a first session for an unseen key, still explicit", () => {
    const r = resolveSessionIdentity({ layers: layersFor(messages(1)), explicitKey: "cc-new" });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(r.client_key).toBe("cc-new");
    expect(r.notes).toContain("explicit_key_first_seen");
  });

  it("records lineage when a key returns after its session closed", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(1)),
      explicitKey: "cc-abc",
      explicitPredecessor: { id: "old" },
    });
    expect(r.predecessor_id).toBe("old");
    expect(r.notes).toContain("explicit_key_reopened_after_close");
  });

  it("keeps the key but opens a successor when the prefix proves a restart", () => {
    const r = resolveSessionIdentity({
      layers: layersFor([{ role: "user", content: "different opening" }]),
      explicitKey: "cc-abc",
      explicitCandidate: candidateFor("s1", messages(6)),
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(r.close_predecessor?.session_id).toBe("s1");
    expect(r.predecessor_id).toBe("s1");
    expect([CLOSE_REASON.PREFIX_DISCONTINUITY, CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED]).toContain(r.boundary);
  });
});

describe("A3 — strong inference requires a proven extension", () => {
  it("refuses a divergent candidate and opens a new session", () => {
    const prev = messages(3);
    const other = [messages(3)[0], { role: "assistant", content: "changed" }, { role: "user", content: "x" }];
    const r = resolveSessionIdentity({ layers: layersFor(other), candidates: [candidateFor("s1", prev)] });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.notes).toContain("candidates_all_divergent");
  });

  it("refuses a candidate whose tools changed, even if the messages extend", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4), { tools: [...TOOLS, { name: "run_shell" }] }),
      candidates: [candidateFor("s1", messages(2))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
  });

  it("refuses a candidate whose system prompt changed", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4), { system: SYSTEM + " Be terse." }),
      candidates: [candidateFor("s1", messages(2))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("candidates_dropped_on_tools_or_system_change");
  });
});

describe("A4 — ambiguity never becomes false certainty", () => {
  it("opens a new session when two candidates both extend", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4)),
      candidates: [candidateFor("s1", messages(2)), candidateFor("s2", messages(2))],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.notes).toContain("multiple_prefix_extension_candidates");
  });

  it("opens a new session when two candidates are equally undecidable", () => {
    const r = resolveSessionIdentity({
      layers: layersFor(messages(4)),
      candidates: [blindCandidate("s1"), blindCandidate("s2")],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.notes).toContain("multiple_ambiguous_candidates");
  });

  it("records a compaction signature without claiming lineage", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "x".repeat(400) + i,
    }));
    const r = resolveSessionIdentity({
      layers: layersFor([{ role: "user", content: "summary of the above" }]),
      candidates: [candidateFor("s1", long)],
    });
    expect(r.action).toBe(RESOLUTION_ACTION.OPEN);
    expect(r.confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect(r.source).toBe(IDENTITY_SOURCE.NEW);
    expect(r.boundary).toBe(CLOSE_REASON.CLIENT_COMPACTION_SUSPECTED);
    expect(r.close_predecessor).toBeNull();
    expect(r.notes).toContain("compaction_shaped_candidate_not_claimed");
  });
});

describe("A5 — a session key is validated before it is trusted", () => {
  // Control characters and separators are built from code points rather than escapes,
  // so what the whitelist sees is exactly the byte named here.
  const BACKSLASH = String.fromCodePoint(92);
  const NUL = String.fromCodePoint(0);
  const LF = String.fromCodePoint(10);

  it("accepts the shapes real agents send", () => {
    for (const key of ["cc-abc", "roo_1.2", "user@host", "A".repeat(MAX_SESSION_KEY_LENGTH)]) {
      expect(validateSessionKey(key).ok, key).toBe(true);
    }
  });

  it("rejects paths, control characters, quoting and oversize input", () => {
    const cases = [
      ["../../etc/passwd", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a..b", SESSION_KEY_REJECTION.PATH_LIKE],
      [".", SESSION_KEY_REJECTION.PATH_LIKE],
      ["C:" + BACKSLASH + "temp" + BACKSLASH + "x", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a/b", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a b", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a;DROP TABLE sessions", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a' OR 1=1 --", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a" + NUL + "b", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["a" + LF + "b", SESSION_KEY_REJECTION.ILLEGAL_CHARACTER],
      ["x".repeat(MAX_SESSION_KEY_LENGTH + 1), SESSION_KEY_REJECTION.TOO_LONG],
      ["", SESSION_KEY_REJECTION.EMPTY],
      [42, SESSION_KEY_REJECTION.NOT_A_STRING],
      [null, SESSION_KEY_REJECTION.ABSENT],
    ];
    for (const [input, reason] of cases) {
      const r = validateSessionKey(input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      expect(r.reason, JSON.stringify(input)).toBe(reason);
      expect(r.key).toBeNull();
    }
  });

  it("rejects keys shaped like credentials so no secret is persisted", () => {
    for (const key of ["sk-abcdefgh", "ghp_abcdefgh", "ya29.abcdefgh", "AIzaAbCdEf", "dxr1:aaaa"]) {
      const r = validateSessionKey(key);
      expect(r.ok, key).toBe(false);
      expect([SESSION_KEY_REJECTION.SECRET_LIKE, SESSION_KEY_REJECTION.ILLEGAL_CHARACTER]).toContain(r.reason);
    }
  });

  it("normalizes and trims before deciding, so one spelling is one verdict", () => {
    // NFC runs first, then the whitelist. The whitelist is ASCII, so a non-ASCII key
    // is rejected in either spelling — the point is that neither form can sneak past
    // by being the other one, and that surrounding whitespace is not part of the key.
    const composed = "caf" + String.fromCodePoint(0xe9);
    const decomposed = "cafe" + String.fromCodePoint(0x301);
    expect(validateSessionKey(composed)).toEqual(validateSessionKey(decomposed));
    expect(validateSessionKey(composed).ok).toBe(false);
    expect(validateSessionKey("  cc-abc  ").key).toBe("cc-abc");
  });
});

describe("A6 — the same rules hold end to end, against a real store", () => {
  const open = [];
  afterEach(() => {
    while (open.length) {
      const h = open.pop();
      h.close();
      removeTmpDir(h.dir);
    }
  });

  const harness = async () => {
    const h = await openHarness({ tag: "ident" });
    open.push(h);
    return h;
  };

  it("continues an inferred conversation across three turns", async () => {
    const h = await harness();
    const t1 = await h.observe(turnRequest({ msgs: messages(1) }));
    h.tick(1000);
    const t2 = await h.observe(turnRequest({ msgs: messages(3) }));
    h.tick(1000);
    const t3 = await h.observe(turnRequest({ msgs: messages(5) }));

    expect(t1.created_session).toBe(true);
    expect(t1.identity_confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
    expect([t2.session_id, t3.session_id]).toEqual([t1.session_id, t1.session_id]);
    expect([t2.turn_idx, t3.turn_idx]).toEqual([1, 2]);
    expect(t3.identity_confidence).toBe(IDENTITY_CONFIDENCE.STRONGLY_INFERRED);
    expect(t3.identity_source).toBe(IDENTITY_SOURCE.PREFIX_EXTENSION);
  });

  it("keeps an independent conversation with the same tools and system apart", async () => {
    const h = await harness();
    const first = await h.observe(turnRequest({ msgs: messages(2) }));
    h.tick(1000);
    const second = await h.observe(turnRequest({ msgs: [{ role: "user", content: "unrelated question" }] }));
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.created_session).toBe(true);
    expect(second.identity_confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
  });

  it("prefers the key over an otherwise perfect inference candidate", async () => {
    const h = await harness();
    const inferred = await h.observe(turnRequest({ msgs: messages(2) }));
    h.tick(1000);
    const keyed = await h.observe(turnRequest({ msgs: messages(4), key: "cc-abc" }));
    expect(keyed.session_id).not.toBe(inferred.session_id);
    expect(keyed.identity_confidence).toBe(IDENTITY_CONFIDENCE.EXPLICIT);
    expect(keyed.identity_source).toBe(IDENTITY_SOURCE.HEADER);
  });

  it("falls back to inference and says so when the key is rejected", async () => {
    const h = await harness();
    const r = await h.observe(turnRequest({ msgs: messages(1), key: "sk-abcdefgh" }));
    expect(r.notes).toContain("session_key_rejected:" + SESSION_KEY_REJECTION.SECRET_LIKE);
    const row = h.db.get("SELECT client_key FROM sessions WHERE id = ?", [r.session_id]);
    expect(row.client_key).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk-abcdefgh");
  });

  it("scopes inferred identity to one project root", async () => {
    const h = await harness();
    const a = await h.observe(turnRequest({ msgs: messages(2), root: "/repo/one" }));
    h.tick(1000);
    const b = await h.observe(turnRequest({ msgs: messages(4), root: "/repo/two" }));
    expect(b.session_id).not.toBe(a.session_id);
    expect(b.identity_confidence).toBe(IDENTITY_CONFIDENCE.UNKNOWN);
  });

  it("never records a confidence outside the enum, or a label it did not earn", async () => {
    const h = await harness();
    await h.observe(turnRequest({ msgs: messages(1) }));
    h.tick(1000);
    await h.observe(turnRequest({ msgs: messages(3) }));
    const rows = h.db.all("SELECT identity_confidence, identity_source, labels FROM turns");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(Object.values(IDENTITY_CONFIDENCE)).toContain(row.identity_confidence);
      expect(Object.values(IDENTITY_SOURCE)).toContain(row.identity_source);
      expect(row.labels ?? "").not.toContain(M1_LABELS.IDENTITY_DEGRADED_BY_LOCK);
    }
  });
});
