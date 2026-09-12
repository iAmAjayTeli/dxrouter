#!/usr/bin/env node
/**
 * Derive a section 15 session fixture from a real agent transcript, WITHOUT content.
 *
 * The M1 brief asks for validation against real agent workloads and forbids dressing
 * synthetic data up as real. This workspace has one genuine source of real traffic
 * shape: the local Claude Code transcript JSONL for this project, which records the
 * actual message stream and the client's own `compactMetadata` (trigger, preTokens,
 * postTokens) for every compaction that really happened.
 *
 * What it is NOT: captured HTTP requests. A transcript is the client's log, not the
 * bytes 9Router received, so the tools array and system prompt are absent and the
 * request sequence is *reconstructed* (history up to and including each user message).
 * The fixture therefore carries `label: "captured_derived"`, and the acceptance
 * criterion that asks for captured request traffic stays BLOCKED.
 *
 * ### What crosses into the repository
 *
 * No message content, ever. Per message: the role, the UTF-8 byte length of the
 * content, and a salted SHA-256 digest truncated to 16 hex characters. The replayer
 * rebuilds each message as filler of exactly that length, seeded by that digest, so:
 *
 *   - two identical original messages rebuild identically, so the prefix chain, the
 *     extension proof and the layer hashes behave as they did on real traffic;
 *   - two different originals rebuild differently, so a real divergence stays one;
 *   - lengths are preserved, so the real compaction shrink ratio is preserved, which
 *     is the one number section 9 detection actually depends on.
 *
 * A truncated keyed digest of a length-known string is not a content archive, and the
 * fixture is useless for reading what anyone said. That is the point.
 *
 * Usage:
 *   node scripts/derive-session-fixture.mjs <transcript.jsonl> --out <file.json>
 *        [--id <fixture-id>] [--salt <salt>] [--max-turns <n>]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SALT = "dxr-fixture-v1";
const DIGEST_CHARS = 16;

function parseArgs(argv) {
  const args = { input: null, out: null, id: null, salt: DEFAULT_SALT, maxTurns: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--id") args.id = argv[++i];
    else if (a === "--salt") args.salt = argv[++i];
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]) || 0;
    else rest.push(a);
  }
  args.input = rest[0] ?? null;
  return args;
}

/** Stable, content-free identity for one message. */
function digestOf(salt, role, content) {
  const body = typeof content === "string" ? content : JSON.stringify(content ?? null);
  const bytes = Buffer.byteLength(body, "utf8");
  const hex = crypto.createHash("sha256").update(`${salt} ${role} ${body}`).digest("hex");
  return { bytes, digest: hex.slice(0, DIGEST_CHARS) };
}

/**
 * Walk the transcript once and produce the message stream plus the turn boundaries.
 *
 * A "turn" is one reconstructed request: every message accumulated so far, ending at
 * a user message, which is when a client actually calls the API. A compaction boundary
 * resets the accumulator, exactly as the client resets its own context.
 */
export function deriveTranscript(lines, { salt = DEFAULT_SALT, maxTurns = 0 } = {}) {
  const messages = [];
  const turns = [];
  const compactions = [];
  const skipped = { unparsable: 0, sidechain: 0, other_types: 0 };
  let segmentStart = 0;
  let pendingCompaction = null;
  let firstAt = null;
  let lastAt = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped.unparsable += 1;
      continue;
    }

    if (entry.compactMetadata) {
      // The client itself says it compacted here, and by how much.
      pendingCompaction = {
        at_turn: turns.length,
        trigger: entry.compactMetadata.trigger ?? null,
        pre_tokens: entry.compactMetadata.preTokens ?? null,
        post_tokens: entry.compactMetadata.postTokens ?? null,
      };
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") {
      skipped.other_types += 1;
      continue;
    }
    if (entry.isSidechain) {
      // A subagent conversation is a different session; keeping it would blur the
      // very boundary this fixture is meant to test.
      skipped.sidechain += 1;
      continue;
    }

    const role = entry.message?.role === "assistant" ? "assistant" : "user";
    const at = Date.parse(entry.timestamp ?? "") || null;
    if (at) {
      if (firstAt === null) firstAt = at;
      lastAt = at;
    }

    if (pendingCompaction) {
      segmentStart = messages.length;
      compactions.push({ ...pendingCompaction, at_turn: turns.length });
      pendingCompaction = null;
    }

    const { bytes, digest } = digestOf(salt, role, entry.message?.content);
    messages.push({ r: role === "assistant" ? "a" : "u", n: bytes, d: digest });

    if (role === "user") {
      turns.push({
        i: turns.length,
        start: segmentStart,
        end: messages.length,
        at,
        compacted_before: compactions.length > 0 && compactions[compactions.length - 1].at_turn === turns.length,
      });
      if (maxTurns && turns.length >= maxTurns) break;
    }
  }

  return { messages, turns, compactions, skipped, first_at: firstAt, last_at: lastAt };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.out) {
    console.error("usage: derive-session-fixture.mjs <transcript.jsonl> --out <file.json> [--id id] [--salt s] [--max-turns n]");
    process.exit(2);
  }
  const raw = fs.readFileSync(args.input, "utf8").split("\n").filter((l) => l.trim());
  const derived = deriveTranscript(raw, { salt: args.salt, maxTurns: args.maxTurns });

  const id = args.id || `cc-transcript-${path.basename(args.input).slice(0, 8)}`;
  const fixture = {
    fixture_id: id,
    label: "captured_derived",
    workload: "Claude Code (claude-cli), one project, one client session",
    source: {
      kind: "claude_code_transcript_jsonl",
      // The path is recorded as a shape, not a location: it is a per-user directory.
      origin: "local Claude Code transcript for this project (per-user path, not stored)",
      lines_read: raw.length,
      derived_by: "scripts/derive-session-fixture.mjs",
      salt_note: "message digests are salted and truncated; the salt used is not stored",
    },
    content: "none. Per message: role, UTF-8 byte length, salted truncated digest.",
    is_captured_http_traffic: false,
    limitations: [
      "reconstructed request sequence: a transcript is the client log, not the request bytes",
      "no tools array and no system prompt in a transcript, so the replay supplies constant ones",
      "tool-change and system-change scenarios cannot come from this fixture (see the synthetic ones)",
      "token counts in the replay are estimator output, not the client's own usage numbers",
    ],
    stats: {
      turns: derived.turns.length,
      messages: derived.messages.length,
      compactions: derived.compactions.length,
      skipped: derived.skipped,
      first_at: derived.first_at,
      last_at: derived.last_at,
    },
    // The client's own numbers for every compaction that really happened. Kept as
    // evidence: the replay must detect these, and the ratio is real.
    compactions: derived.compactions,
    expected: {
      // Keyless traffic: a detected compaction opens a successor without claiming
      // lineage (section 4 forbids the guess), every other turn extends its session.
      compaction_boundaries: derived.compactions.length,
      false_continuations: 0,
      false_splits_outside_compactions: 0,
    },
    messages: derived.messages,
    turns: derived.turns,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(fixture, null, 1)}\n`, "utf8");
  console.log(
    `wrote ${args.out}: ${fixture.stats.turns} turns, ${fixture.stats.messages} messages, ` +
      `${fixture.stats.compactions} real compactions, 0 bytes of content`,
  );
}

if (import.meta.url === `file://${process.argv[1].split(path.sep).join("/")}` || process.argv[1]?.endsWith("derive-session-fixture.mjs")) {
  main();
}

export default deriveTranscript;
