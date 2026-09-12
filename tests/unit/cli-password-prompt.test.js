/**
 * Hidden password entry in the CLI.
 *
 * The property under test is negative and easy to lose in a refactor: the
 * characters typed at a password prompt reach no output stream. That is asserted
 * by driving a fake TTY and capturing every write to stdout, rather than by
 * inspecting the implementation — a rewritten prompt that echoes again would
 * still pass a test that only checked the return value.
 *
 * Raw mode has to be faked because a password prompt is only hideable while the
 * CLI owns the byte stream: in cooked mode the terminal echoes the keystrokes
 * itself, before any of this code sees them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";

const inputModule = await import("../../cli/src/cli/utils/input.js");
const { promptHidden, promptNewSecret } = inputModule.default ?? inputModule;

let realStdin;
let writes;

/** A stdin that claims to be a TTY, so the prompt takes the hidden path. */
function fakeTty() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.setEncoding = () => {};
  return stdin;
}

function useStdin(stdin) {
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
}

/** Send characters as readline would report them. */
function type(stdin, text) {
  for (const ch of text) stdin.emit("keypress", ch, { name: ch, ctrl: false, meta: false });
}

function pressEnter(stdin) {
  stdin.emit("keypress", "\r", { name: "return", ctrl: false, meta: false });
}

/** Let a queued continuation register its listener before the next keystroke. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  realStdin = process.stdin;
  writes = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  useStdin(realStdin);
  vi.restoreAllMocks();
});

describe("promptHidden", () => {
  it("returns what was typed and writes none of it to stdout", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const answer = promptHidden("  New password: ");
    type(stdin, "s3cret-passphrase");
    pressEnter(stdin);

    await expect(answer).resolves.toBe("s3cret-passphrase");

    const printed = writes.join("");
    expect(printed).toContain("New password:");
    expect(printed).not.toContain("s3cret-passphrase");
    // Not even character by character.
    expect(printed).not.toContain("s3cret");
    expect(printed).not.toContain("passphrase");
  });

  it("does not expose the password through the terminating newline", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const answer = promptHidden("  New password: ");
    type(stdin, "hunter2");
    pressEnter(stdin);
    await answer;

    expect(writes.join("")).not.toContain("hunter2");
  });

  it("honours backspace without echoing the erased characters", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const answer = promptHidden("  New password: ");
    type(stdin, "abcX");
    stdin.emit("keypress", "\x7f", { name: "backspace", ctrl: false, meta: false });
    type(stdin, "d");
    pressEnter(stdin);

    await expect(answer).resolves.toBe("abcd");
    expect(writes.join("")).not.toContain("abcX");
  });

  it("drops arrows and control chords rather than inserting escape bytes", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const answer = promptHidden("  New password: ");
    type(stdin, "s");
    stdin.emit("keypress", undefined, { name: "up", ctrl: false, meta: false });
    stdin.emit("keypress", "\x01", { name: "a", ctrl: true, meta: false });
    stdin.emit("keypress", "\t", { name: "tab", ctrl: false, meta: false });
    type(stdin, "t");
    pressEnter(stdin);

    await expect(answer).resolves.toBe("st");
  });

  it("keeps whitespace, which is part of the password", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const answer = promptHidden("  New password: ");
    type(stdin, " pass phrase ");
    pressEnter(stdin);

    await expect(answer).resolves.toBe(" pass phrase ");
  });
});

describe("promptNewSecret", () => {
  async function enter(stdin, first, second) {
    const pending = promptNewSecret();
    type(stdin, first);
    pressEnter(stdin);
    await tick();
    type(stdin, second);
    pressEnter(stdin);
    return pending;
  }

  it("accepts two matching entries", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    await expect(enter(stdin, "chosen-password", "chosen-password")).resolves.toEqual({
      ok: true,
      value: "chosen-password",
    });
    expect(writes.join("")).not.toContain("chosen-password");
  });

  it("reports a mismatch instead of storing the first entry", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const result = await enter(stdin, "chosen-password", "chosen-passwrod");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Passwords do not match");
    // The first entry is not handed back for the caller to store anyway.
    expect(JSON.stringify(result)).not.toContain("chosen-password");
  });

  it("rejects an empty password", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const pending = promptNewSecret();
    pressEnter(stdin);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Password must not be empty",
    });
  });

  it("rejects a whitespace-only password", async () => {
    const stdin = fakeTty();
    useStdin(stdin);

    const pending = promptNewSecret();
    type(stdin, "    ");
    pressEnter(stdin);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Password must not be only whitespace",
    });
  });
});
