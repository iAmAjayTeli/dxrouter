/**
 * Shared harness for the M1 session suites.
 *
 * A real SQLite file on every run, never a mock: the milestone's claims are about
 * what is *persisted* (§14 F/H), and a mocked store cannot tell you that a column
 * exists, that a conditional UPDATE actually raced, or that no request body reached
 * the database. `sql.js` is used because it is the one driver present on every
 * machine, and the store handle contract it satisfies is the same one the server
 * uses in production.
 *
 * Time and identity are injected everywhere: `clock` is a mutable counter, `newId`
 * is a deterministic sequence. Tests that need "one hour later" move the number.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { openContinuityStore } from "../../../continuity/store/index.js";
import { observeTurn } from "../../../continuity/session/observer.js";

export const START_AT = 1_700_000_000_000;

/** A fresh temp directory the caller is responsible for removing. */
export function makeTmpDir(tag = "m1") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dxr-${tag}-`));
}

export function removeTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: Windows can hold the SQLite handle briefly */
  }
}

/**
 * Open a store on a real file plus the injected effects M1 needs.
 *
 * @returns {Promise<{store, db, clock, tick, at, newId, observe, dir, file}>}
 */
export async function openHarness({ dir = null, name = "continuity", tag = "m1", start = START_AT } = {}) {
  const baseDir = dir || makeTmpDir(tag);
  const file = path.join(baseDir, `${name}.sqlite`);
  const db = await createSqlJsAdapter(file);
  const store = openContinuityStore({ db });

  let now = start;
  const clock = { now: () => now };
  let seq = 0;
  const newId = () => `s${++seq}`;

  const harness = {
    store,
    db,
    dir: baseDir,
    file,
    clock,
    newId,
    at: () => now,
    tick: (ms) => {
      now += ms;
      return now;
    },
    /** One observation with the harness effects wired in. `sleep` is a no-op. */
    observe: (request, extra = {}) =>
      observeTurn({
        store,
        request,
        clock,
        newId,
        owner: "1:test",
        sleep: async () => {},
        ...extra,
      }),
    close: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
  return harness;
}

/** `k` alternating user/assistant messages with stable content. */
export function messages(k, salt = "") {
  return Array.from({ length: k }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `${salt}turn ${i}`,
  }));
}

export const TOOLS = [
  { name: "read_file", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "write a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

export const SYSTEM = "You are a coding agent working in a repository.";

/** The request shape `observeTurn` expects, with the common fields filled in. */
export function turnRequest({ msgs = messages(1), tools = TOOLS, system = SYSTEM, key = null, root = "/repo/one", ...rest } = {}) {
  return {
    tools,
    system,
    messages: msgs,
    protocol: "openai",
    model: "gpt-test",
    client_hint: { session_key: key, project_root: root },
    ...rest,
  };
}
