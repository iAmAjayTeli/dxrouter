/**
 * The remaining places that told a user, a provider or a tool the wrong local port.
 *
 * Three surfaces, each wrong for a different reason:
 *
 *   · the OAuth authorize route fell back to `http://localhost:8080/callback` — a port
 *     belonging to neither DXRouter (20127) nor upstream (20128) nor any provider
 *   · the CLI settings header printed `http://localhost:20128/v1`, upstream's port, while
 *     the CLI itself defaults to 20127
 *   · seven dashboard components carried 20128 as their server-render fallback
 *
 * The OAuth case is the only one with protocol consequences, and its fix is not a port at
 * all: `src/app/callback/page.js` relays the authorization code through `postMessage`,
 * `BroadcastChannel` and `localStorage`, all origin-scoped against
 * `[window.location.origin, "http://localhost:1455"]`. A callback on any other origin
 * cannot deliver the code, so the correct fallback is the request's own origin.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const OAUTH_ROUTE = "src/app/api/oauth/[provider]/[action]/route.js";

/** Comments may name what was removed without reinstating it. */
const codeOnly = (rel) =>
  read(rel)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join("\n");

// ---------------------------------------------------------------------------
// TARGET 1 — OAuth callback fallback
// ---------------------------------------------------------------------------

describe("the OAuth authorize fallback lands on this dashboard's own origin", () => {
  /** `defaultCallbackOrigin` is module-private, so it is extracted and evaluated. */
  const defaultCallbackOrigin = (() => {
    const src = read(OAUTH_ROUTE);
    const fn = src.match(/function defaultCallbackOrigin\(request\) \{[\s\S]*?\n\}/)[0];
    return new Function(`const DXR_DEFAULT_APP_PORT = 20127;\n${fn}\nreturn defaultCallbackOrigin;`)();
  })();

  const requestWith = (headers, url = "http://localhost:20127/api/oauth/claude/authorize") => ({
    headers: { get: (k) => headers[k.toLowerCase()] ?? "" },
    url,
  });

  it("uses the host the dashboard was reached on", () => {
    expect(defaultCallbackOrigin(requestWith({ host: "localhost:20127" })))
      .toBe("http://localhost:20127");
    // A dashboard on a non-default port must get its own port back, not a constant.
    expect(defaultCallbackOrigin(requestWith({ host: "localhost:31000" }, "http://localhost:31000/x")))
      .toBe("http://localhost:31000");
  });

  it("honours reverse-proxy headers, including the scheme", () => {
    expect(defaultCallbackOrigin(requestWith({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "router.example.com",
      host: "localhost:20127",
    }))).toBe("https://router.example.com");
  });

  it("falls back to the request URL origin when no host header is present", () => {
    expect(defaultCallbackOrigin(requestWith({}, "https://router.example.com/api/oauth/claude/authorize")))
      .toBe("https://router.example.com");
  });

  it("uses the canonical DXRouter port only when nothing can be derived", () => {
    // Not 8080. This is the last resort, and it is the one place a constant is right.
    expect(defaultCallbackOrigin(undefined)).toBe("http://localhost:20127");
    expect(defaultCallbackOrigin({ headers: { get: () => "" }, url: "not-a-url" }))
      .toBe("http://localhost:20127");
  });

  it("never produces the inherited 8080 origin", () => {
    for (const req of [undefined, requestWith({}), requestWith({ host: "localhost:20127" })]) {
      expect(defaultCallbackOrigin(req)).not.toContain("8080");
    }
    expect(codeOnly(OAUTH_ROUTE)).not.toContain("8080");
  });

  it("keeps a caller-supplied redirect_uri winning over the fallback", () => {
    const code = codeOnly(OAUTH_ROUTE);
    // The `||` order is the whole contract: an explicit value is never overridden, which is
    // what lets a provider with a fixed loopback port name it.
    expect(code).toMatch(
      /searchParams\.get\("redirect_uri"\)\s*\|\|\s*`\$\{defaultCallbackOrigin\(request\)\}\/callback`/
    );
  });

  it("leaves every provider-specific callback port untouched", () => {
    // Codex 1455 is the one this milestone was explicitly told not to touch; the others are
    // the same class of deliberate, provider-mandated loopback port.
    expect(read("src/shared/components/OAuthModal.js")).toContain("http://localhost:1455/auth/callback");
    expect(read("cli/src/cli/api/client.js")).toContain('"http://localhost:1455/auth/callback"');
    expect(read("src/shared/components/OAuthModal.js")).toContain("http://127.0.0.1:56121/callback");
    expect(read("src/lib/oauth/constants/xai.js")).toContain("56121");
    expect(read("src/lib/oauth/constants/oauth.js")).toContain("58443");
    // And the route still derives zed's port from the caller's redirect URI.
    expect(codeOnly(OAUTH_ROUTE)).toMatch(/meta\.nativeAppPort = p/);
  });

  it("still relays only to origins the callback page trusts", () => {
    // Why the fallback must be same-origin rather than any fixed port.
    const page = read("src/app/callback/page.js");
    expect(page).toContain("window.location.origin");
    expect(page).toContain("http://localhost:1455");
  });
});

// ---------------------------------------------------------------------------
// TARGET 2 — CLI settings display
// ---------------------------------------------------------------------------

describe("the CLI settings header shows the port the CLI is actually on", () => {
  const settings = read("cli/src/cli/menus/settings.js");

  /** Renders the endpoint line the way the menu does, for a given port and tunnel state. */
  const endpointLine = (port, tunnel) => {
    const COLORS = { green: "", red: "", dim: "", reset: "" };
    // Anchored on the next section's comment: a non-greedy match to the first `}` stops at
    // the `if`'s closing brace and silently drops the else branch being tested.
    const body = settings.match(
      /const tunnel = data\?\.tunnel \|\| \{\};[\s\S]*?(?=\n\s*\/\/ RTK section)/
    )[0];
    return new Function(
      "COLORS", "data", "port",
      `const lines = [];\n${body}\nreturn lines;`
    )(COLORS, { tunnel }, port);
  };

  it("takes the port as a parameter rather than hardcoding one", () => {
    expect(settings).toMatch(/async function showSettingsMenu\(port, breadcrumb = \[\]\)/);
    expect(codeOnly("cli/src/cli/menus/settings.js")).not.toContain("20128");
    // And no new literal was introduced in its place.
    expect(codeOnly("cli/src/cli/menus/settings.js")).not.toContain("20127");
  });

  it("displays the DXRouter default when the CLI is on its default port", () => {
    // 20127 comes from cli.js's DEFAULT_PORT, not from this menu.
    const defaultPort = Number(read("cli/cli.js").match(/const DEFAULT_PORT = (\d+);/)[1]);
    expect(defaultPort).toBe(20127);

    const lines = endpointLine(defaultPort, {});
    expect(lines[0]).toContain(`http://localhost:${defaultPort}/v1`);
    expect(lines[0]).not.toContain("20128");
  });

  it("displays a non-default configured port correctly", () => {
    const lines = endpointLine(31000, {});
    expect(lines[0]).toContain("http://localhost:31000/v1");
  });

  it("still prefers the tunnel URL when a tunnel is up", () => {
    const lines = endpointLine(20127, { enabled: true, publicUrl: "https://r-abc.example", shortId: "abc" });
    expect(lines[0]).toContain("https://r-abc.example/v1");
    expect(lines[0]).not.toContain("localhost");
  });

  it("is passed the port by its only caller", () => {
    const ui = read("cli/src/cli/terminalUI.js");
    expect(ui).toMatch(/showSettingsMenu\(port, \[\.\.\.basePath, "Settings"\]\)/);
    // Matching how the sibling menus already receive it — one convention, not two.
    expect(ui).toMatch(/showApiKeysMenu\(port,/);
    expect(ui).toMatch(/showCliToolsMenu\(port,/);
  });

  it("keeps the CLI's single source of truth for the port", () => {
    // No getter was added to the api client: the port still flows outward from cli.js only.
    const client = read("cli/src/cli/api/client.js");
    expect(client).not.toMatch(/\bgetPort\b|\bgetConfig\b/);
    expect(read("cli/cli.js")).toContain('require("./src/cli/api/client").configure({ port })');
  });
});

// ---------------------------------------------------------------------------
// TARGET 3 — dashboard components and landing copy
// ---------------------------------------------------------------------------

describe("dashboard components fall back to the canonical port, not upstream's", () => {
  const CARDS = [
    "src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/JcodeToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/OpenClawToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/GrokBuildToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js",
    "src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js",
    "src/app/(dashboard)/dashboard/media-providers/combo/[id]/page.js",
    "src/app/landing/components/GetStarted.js",
  ];

  it("carries no 20128 fallback in any of them", () => {
    const offenders = CARDS.filter((rel) => codeOnly(rel).includes("20128"));
    expect(offenders).toEqual([]);
  });

  it("derives the port from the shared constant rather than a new literal", () => {
    for (const rel of CARDS) {
      const code = codeOnly(rel);
      expect(code, rel).toContain("UPDATER_CONFIG.appPort");
      expect(code, rel).toMatch(/from "@\/shared\/constants\/config"/);
    }
  });

  it("preserves browser-origin behaviour, which is what actually runs", () => {
    // The constant is only the server-render fallback. Losing this branch would pin the
    // dashboard to a port instead of following the origin it was served from.
    const WINDOW_GUARDED = [
      "src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekTuiToolCard.js",
      "src/app/(dashboard)/dashboard/cli-tools/components/HermesToolCard.js",
      "src/app/(dashboard)/dashboard/cli-tools/components/JcodeToolCard.js",
      "src/app/(dashboard)/dashboard/cli-tools/components/OpenClawToolCard.js",
      "src/app/(dashboard)/dashboard/cli-tools/components/GrokBuildToolCard.js",
      "src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js",
    ];
    for (const rel of WINDOW_GUARDED) {
      expect(codeOnly(rel), rel).toMatch(/typeof window !== "undefined"/);
    }
    expect(codeOnly("src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js"))
      .toContain("window.location.origin");

    // DefaultToolCard is the exception by design: it has no window branch, it falls back
    // only when the `baseUrl` prop it is given is falsy — and its caller always supplies one.
    expect(codeOnly("src/app/(dashboard)/dashboard/cli-tools/components/DefaultToolCard.js"))
      .toMatch(/const normalizedBaseUrl = baseUrl \|\|/);
  });
});

describe("the landing string and its translations stay in lockstep", () => {
  const KEY = "Point your CLI tools to http://localhost:20127";
  const OLD_KEY = "Point your CLI tools to http://localhost:20128";
  const LOCALES = ["fa", "km", "pt-BR", "th", "zh-CN"];

  it("uses a literal port in the one string that is also a translation key", () => {
    // Interpolating the constant here would make the rendered text unmatchable against a
    // static JSON key, silently dropping five locales back to English. That is why this one
    // string is exempt from the constant.
    const src = read("src/app/landing/components/GetStarted.js");
    expect(src).toContain(KEY);
    expect(src).not.toContain(OLD_KEY);
  });

  it("retargets the key in every locale that had it, and only those", () => {
    const dir = path.join(REPO_ROOT, "public/i18n/literals");
    const withKey = [];
    const withOldKey = [];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (KEY in parsed) withKey.push(file.replace(/\.json$/, ""));
      if (OLD_KEY in parsed) withOldKey.push(file.replace(/\.json$/, ""));
    }

    expect(withKey.sort()).toEqual([...LOCALES].sort());
    expect(withOldKey).toEqual([]);
  });

  it("keeps each translation translated, with only the port changed", () => {
    for (const locale of LOCALES) {
      const parsed = JSON.parse(read(`public/i18n/literals/${locale}.json`));
      const value = parsed[KEY];

      expect(value, locale).toBeTruthy();
      expect(value, locale).toContain("http://localhost:20127");
      expect(value, locale).not.toContain("20128");
      // Still a translation, not an English copy-paste.
      expect(value, locale).not.toBe(KEY);
    }
  });

  it("leaves every locale file parseable", () => {
    const dir = path.join(REPO_ROOT, "public/i18n/literals");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      expect(() => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), file).not.toThrow();
    }
  });
});
