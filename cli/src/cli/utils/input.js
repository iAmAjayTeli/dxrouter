const readline = require("readline");

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgBlue: "\x1b[44m",
  black: "\x1b[30m",
  terracotta: "\x1b[38;2;217;119;87m",
  bgTerracotta: "\x1b[48;2;217;119;87m"
};

// Prime stdin once globally. Toggling raw mode between menus adds latency on
// macOS, so we keep raw mode on for the whole TUI session.
let rawPrimed = false;
function primeRawOnce() {
  if (rawPrimed || !process.stdin.isTTY) return;
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    rawPrimed = true;
  } catch {}
}

function suspendRawFor(fn) {
  // Temporarily drop raw mode so readline.question can buffer line input.
  const wasPrimed = rawPrimed;
  if (wasPrimed && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  return fn().finally(() => {
    if (wasPrimed && process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
      process.stdin.resume();
    }
  });
}

async function prompt(question) {
  return suspendRawFor(() => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  }));
}

async function select(question, options) {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  while (true) {
    const answer = await prompt("\nSelect option (number): ");
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= options.length) return num - 1;
    console.log(`Invalid selection. Please enter a number between 1 and ${options.length}`);
  }
}

async function confirm(question) {
  while (true) {
    const answer = await prompt(`${question} (y/n): `);
    const lower = answer.toLowerCase();
    if (lower === "y" || lower === "yes") return true;
    if (lower === "n" || lower === "no") return false;
    console.log("Please answer 'y' or 'n'");
  }
}

/** Key names that carry no character of their own and must not enter a secret. */
const NON_CHARACTER_KEYS = new Set([
  "up", "down", "left", "right", "escape", "tab", "delete", "insert",
  "home", "end", "pageup", "pagedown", "clear"
]);

/**
 * Read a line whose characters are never echoed.
 *
 * Raw mode is turned ON for the duration rather than off. In cooked mode the
 * terminal itself echoes every keystroke, so there would be nothing left for
 * this function to suppress; owning the byte stream is what makes hiding the
 * input possible at all.
 *
 * Only the prompt and the terminating newline are written. The characters typed
 * between them are accumulated in a local buffer and returned — never written to
 * stdout, never put in a log line, never stored on an object that outlives the
 * call.
 *
 * Without a TTY (piped input, CI) raw mode does not exist and there is no echo
 * to hide, so this degrades to an ordinary line read and stays scriptable.
 *
 * @param {string} question prompt text, written once
 * @returns {Promise<string>} exactly what was typed, untrimmed
 */
async function promptHidden(question) {
  if (!process.stdin.isTTY) return prompt(question);

  primeRawOnce();
  const stdin = process.stdin;
  process.stdout.write(question);

  return new Promise((resolve) => {
    let buffer = "";

    const onKeypress = (str, key) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        stdin.removeListener("keypress", onKeypress);
        process.stdout.write("\n");
        process.exit(0);
      }

      // The newline is still written so the next line starts clean; it reveals
      // only that Enter was pressed, which the prompt already implies.
      if (key.name === "return" || key.name === "enter") {
        stdin.removeListener("keypress", onKeypress);
        process.stdout.write("\n");
        resolve(buffer);
        return;
      }

      if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
        return;
      }

      // Control chords, arrows and function keys are dropped rather than
      // inserted: `str` for those is an escape sequence, and a control byte in a
      // password is unusable because there is no way to type it back reliably.
      if (key.ctrl || key.meta || !str || NON_CHARACTER_KEYS.has(key.name)) return;

      buffer += str;
    };

    stdin.on("keypress", onKeypress);
    stdin.resume();
  });
}

/**
 * Ask for a new password twice, with no echo, and require the two to match.
 *
 * Returns a result rather than throwing or silently re-prompting: the menu
 * decides how to report a mismatch, and a hidden retry loop would leave the
 * operator believing their first entry was the one that got stored.
 *
 * The emptiness rule mirrors `validateNewPassword` in src/lib/security/
 * passwordPolicy.js. It is duplicated rather than imported because cli/ is a
 * separate published package and cannot reach into the server's source tree —
 * keep the two in step, including the wording, so a CLI rejection and an API
 * rejection read the same.
 *
 * @param {{first?: string, second?: string}} [prompts] prompt text overrides
 * @returns {Promise<{ok: true, value: string} | {ok: false, error: string}>}
 */
async function promptNewSecret(prompts = {}) {
  const firstPrompt = prompts.first ?? "\n  New password: ";
  const secondPrompt = prompts.second ?? "  Confirm new password: ";

  const value = await promptHidden(firstPrompt);
  if (!value) return { ok: false, error: "Password must not be empty" };
  if (value.trim().length === 0) return { ok: false, error: "Password must not be only whitespace" };

  const confirmation = await promptHidden(secondPrompt);
  if (value !== confirmation) return { ok: false, error: "Passwords do not match" };

  return { ok: true, value };
}

async function pause(message = "Press Enter to continue...") {
  return suspendRawFor(() => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  }));
}

/**
 * Interactive arrow-key menu. Renders ★/☆ icons; selected line uses reverse+bright
 * (no underline). Uses readline keypress + raw 'data' fallback to prevent
 * arrow-key escape sequence leaks on macOS.
 */
async function selectMenu(title, items, defaultIndex = 0, subtitle = "", headerContent = "", breadcrumb = []) {
  return new Promise((resolve) => {
    let selectedIndex = defaultIndex;
    let isActive = true;

    primeRawOnce();
    if (!process.stdin.isTTY) { resolve(-1); return; }

    const renderMenu = () => {
      if (!isActive) return;
      process.stdout.write("\x1b[2J\x1b[H");
      const width = Math.min(process.stdout.columns || 40, 40);
      console.log(`\n${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
      console.log(`  ${COLORS.bright}${COLORS.terracotta}${title}${COLORS.reset}`);
      if (subtitle) console.log(`  ${COLORS.dim}${subtitle}${COLORS.reset}`);
      console.log(`${COLORS.terracotta}${"=".repeat(width)}${COLORS.reset}`);
      if (breadcrumb.length > 0) console.log(`  ${COLORS.dim}${breadcrumb.join(" > ")}${COLORS.reset}`);
      console.log();
      if (headerContent) { console.log(headerContent); console.log(); }

      const isWin = process.platform === "win32";
      items.forEach((item, index) => {
        const isSelected = index === selectedIndex;
        const icon = isSelected ? (isWin ? ">" : "★") : (isWin ? " " : "☆");
        if (isSelected) {
          console.log(` ${COLORS.reverse}${COLORS.bright}${icon} ${item.label}${COLORS.reset}`);
        } else {
          console.log(`  ${icon} ${item.label}`);
        }
      });
    };

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      process.stdin.removeListener("keypress", onKeypress);
    };

    const move = (delta) => {
      selectedIndex = (selectedIndex + delta + items.length) % items.length;
      renderMenu();
    };

    const onKeypress = (_str, key) => {
      if (!isActive || !key) return;
      if (key.name === "up") return move(-1);
      if (key.name === "down") return move(1);
      if (key.name === "return") { cleanup(); resolve(selectedIndex); return; }
      if (key.name === "escape") { cleanup(); resolve(-1); return; }
      if (key.ctrl && key.name === "c") { cleanup(); process.exit(0); }
    };

    process.stdin.on("keypress", onKeypress);
    renderMenu();
  });
}

module.exports = {
  prompt,
  promptHidden,
  promptNewSecret,
  select,
  confirm,
  pause,
  selectMenu,
  COLORS
};
