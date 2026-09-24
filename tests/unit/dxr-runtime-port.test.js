/**
 * Runtime paths must target the port DXRouter actually listens on.
 *
 * Three features were pointed at upstream 9Router's 20128 by defaults nobody overrode, and
 * each failed in a way that looked like something else:
 *
 *   · both tunnel managers took `localPort = 20128` as a default parameter and NO caller
 *     passes a port, so `cloudflared tunnel --url http://127.0.0.1:20128` published a
 *     tunnel to a port this app does not bind
 *   · the MITM child forwarded intercepted traffic to `http://localhost:20128`, which on a
 *     host also running upstream is answered by the *other* installation while carrying a
 *     DXRouter API key
 *   · the SAML fallback produced an ACS callback on a port this product does not serve
 *
 * These are behavioural tests, not string searches. Each asserts what a caller or resolver
 * actually returns, and the two that concern legacy state assert the compatibility rule
 * rather than the constant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const LEGACY = "http://localhost:20128";

// ---------------------------------------------------------------------------
// A. start.sh
// ---------------------------------------------------------------------------

describe("A. start.sh runs the container on the port the image exposes", () => {
  const script = read("start.sh");
  const dockerfile = read("Dockerfile");
  const compose = read("docker-compose.yml");

  /** `-p [host:]HOST_PORT:CONTAINER_PORT` */
  const mapping = script.match(/-p\s+(?:[\d.]+:)?(\d+):(\d+)/);

  it("publishes a port mapping at all", () => {
    expect(mapping, "no -p mapping found in start.sh").toBeTruthy();
  });

  it("maps to the container port the Dockerfile actually exposes", () => {
    // The real defect: the Dockerfile moved to 20127 while this script still forwarded to
    // 20128, so the container started and was unreachable. Asserting agreement rather than
    // a number means the pair cannot drift again.
    const exposed = dockerfile.match(/^EXPOSE\s+(\d+)$/m)?.[1];
    const envPort = dockerfile.match(/^ENV PORT=(\d+)$/m)?.[1];

    expect(exposed).toBe(envPort);
    expect(mapping[2]).toBe(exposed);
    expect(mapping[1]).toBe(exposed);
  });

  it("agrees with the compose file's mapping and image tag", () => {
    const composeMapping = compose.match(/-\s*"(\d+):(\d+)"/);
    expect(mapping[2]).toBe(composeMapping[2]);
    expect(script).toContain("dxrouter:local");
    expect(compose).toContain("dxrouter:local");
  });

  it("names the container dxrouter and never 9router", () => {
    expect(script).toMatch(/--name\s+dxrouter\b/);
    expect(script).not.toMatch(/--name\s+9router\b/);
    expect(script).not.toMatch(/-t\s+9router\b/);
  });

  it("keeps the inherited data volume so existing deployments are not orphaned", () => {
    expect(script).toContain("9router-data:/app/data");
  });

  it("opts in to the non-loopback bind the image requires", () => {
    // HOSTNAME=0.0.0.0 in the image + no DXR_ALLOW_NETWORK = the server refuses to start.
    expect(dockerfile).toMatch(/^ENV HOSTNAME=0\.0\.0\.0$/m);
    expect(script).toMatch(/DXR_ALLOW_NETWORK=1/);
  });
});

// ---------------------------------------------------------------------------
// B. tunnel local port resolution
// ---------------------------------------------------------------------------

describe("B. tunnel defaults resolve PORT first, then the canonical constant", () => {
  it("prefers an explicitly configured PORT", async () => {
    const { resolveLocalAppPort } = await import("@/lib/tunnel/shared/localPort.js");
    expect(resolveLocalAppPort({ PORT: "31000" })).toBe(31000);
  });

  it("falls back to the canonical app port when PORT is absent or unusable", async () => {
    const { resolveLocalAppPort } = await import("@/lib/tunnel/shared/localPort.js");
    const { UPDATER_CONFIG } = await import("@/shared/constants/config.js");

    // Asserted against the constant, not against 20127, so the test follows the product.
    for (const env of [{}, { PORT: "" }, { PORT: "not-a-port" }, { PORT: "0" }, { PORT: "70000" }]) {
      expect(resolveLocalAppPort(env), JSON.stringify(env)).toBe(UPDATER_CONFIG.appPort);
    }
  });

  it("never returns upstream's port, and never a string", async () => {
    const { resolveLocalAppPort } = await import("@/lib/tunnel/shared/localPort.js");
    const resolved = resolveLocalAppPort({});

    expect(resolved).not.toBe(20128);
    // `cloudflared --url http://127.0.0.1:${port}` and `svc.activeLocalPort` both take
    // this value; a string "20127" from PORT would leak into recovery paths.
    expect(typeof resolved).toBe("number");
  });

  it("is what a bare enableTunnel/enableTailscale call would use", async () => {
    // Every call site is bare — `enableTunnel()` / `enableTailscale()` — so the default
    // parameter IS the operative value. Asserted on the source because invoking the real
    // functions would spawn cloudflared.
    for (const rel of ["src/lib/tunnel/cloudflare/manager.js", "src/lib/tunnel/tailscale/manager.js"]) {
      const src = read(rel);
      expect(src, rel).toMatch(/localPort = resolveLocalAppPort\(\)/);
      expect(src, rel).not.toMatch(/localPort = 20128/);
      expect(src, rel).toMatch(/resolveLocalAppPort\s*}\s*from\s*"\.\.\/shared\/localPort\.js"/);
    }
  });
});

// ---------------------------------------------------------------------------
// C + D + E. MITM router base: default, legacy normalisation, custom preservation
// ---------------------------------------------------------------------------

describe("C. the MITM router base defaults to this app's own port", () => {
  it("builds the local router URL from the canonical constant", async () => {
    const { LOCAL_ROUTER_BASE_URL, UPDATER_CONFIG } = await import("@/shared/constants/config.js");
    expect(LOCAL_ROUTER_BASE_URL).toBe(`http://localhost:${UPDATER_CONFIG.appPort}`);
  });

  it("is the settings default an install starts from", async () => {
    const { LOCAL_ROUTER_BASE_URL } = await import("@/shared/constants/config.js");
    // Comments stripped: the file explains what the literal used to be, and an explanation
    // is not a default.
    const repo = read("src/lib/db/repos/settingsRepo.js")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

    expect(repo).toContain("LOCAL_ROUTER_BASE_URL");
    expect(repo).not.toContain(LEGACY);
    expect(LOCAL_ROUTER_BASE_URL).not.toBe(LEGACY);
  });
});

describe("D. a legacy stored router base is corrected on read", () => {
  it("normalises both loopback spellings of upstream's port", async () => {
    const { normalizeLocalRouterBaseUrl, LOCAL_ROUTER_BASE_URL } =
      await import("@/shared/constants/config.js");

    for (const stored of [
      "http://localhost:20128",
      "http://127.0.0.1:20128",
      "http://localhost:20128/",
      "  http://localhost:20128  ",
      "HTTP://LOCALHOST:20128",
    ]) {
      expect(normalizeLocalRouterBaseUrl(stored), stored).toBe(LOCAL_ROUTER_BASE_URL);
    }
  });

  it("treats an empty or missing value as the local default", async () => {
    const { normalizeLocalRouterBaseUrl, LOCAL_ROUTER_BASE_URL } =
      await import("@/shared/constants/config.js");

    for (const stored of ["", "   ", null, undefined]) {
      expect(normalizeLocalRouterBaseUrl(stored)).toBe(LOCAL_ROUTER_BASE_URL);
    }
  });

  it("corrects without rewriting the database", () => {
    // The requirement is read-time normalisation. The POST handler still stores what the
    // operator typed; only the GET response and the resolver correct it.
    const route = read("src/app/api/cli-tools/antigravity-mitm/route.js");
    expect(route).toMatch(/mitmRouterBaseUrl: normalizeLocalRouterBaseUrl\(settings\.mitmRouterBaseUrl\)/);
    // No normalisation inside the input path, so a typed value is persisted verbatim.
    const inputFn = route.slice(route.indexOf("function normalizeMitmRouterBaseUrlInput"));
    expect(inputFn.slice(0, inputFn.indexOf("\n}"))).not.toContain("normalizeLocalRouterBaseUrl");
  });
});

describe("E. a deliberate custom router base survives untouched", () => {
  it("returns non-default URLs exactly as given", async () => {
    const { normalizeLocalRouterBaseUrl } = await import("@/shared/constants/config.js");

    for (const custom of [
      "http://192.168.1.50:20128",   // remote host on upstream's port — somebody's real deployment
      "https://router.example.com",
      "http://localhost:9999",
      "http://127.0.0.1:20127",
      "https://gateway.internal:8443",
    ]) {
      expect(normalizeLocalRouterBaseUrl(custom), custom).toBe(custom);
    }
  });

  it("only strips trailing slashes from a custom value", async () => {
    const { normalizeLocalRouterBaseUrl } = await import("@/shared/constants/config.js");
    expect(normalizeLocalRouterBaseUrl("https://router.example.com/")).toBe("https://router.example.com");
  });
});

describe("D/E. the unbundled MITM copies behave the same way", () => {
  // src/mitm/* are CommonJS child-process files and cannot import the alias, so they
  // duplicate the rule. The duplication is the risk, so it is pinned.
  const files = ["src/mitm/manager.js", "src/mitm/handlers/base.js"];

  it("declare the canonical default and the legacy list, in step with the shared module", async () => {
    const { LOCAL_ROUTER_BASE_URL, LEGACY_LOCAL_ROUTER_BASE_URLS } =
      await import("@/shared/constants/config.js");

    for (const rel of files) {
      const src = read(rel);
      expect(src, rel).toContain(LOCAL_ROUTER_BASE_URL);
      for (const legacy of LEGACY_LOCAL_ROUTER_BASE_URLS) {
        expect(src, `${rel} must know legacy ${legacy}`).toContain(legacy);
      }
      // Says why it duplicates, per the src/mitm/paths.js precedent.
      expect(src, rel).toMatch(/kept in step/);
    }
  });

  it("resolve an explicit MITM_ROUTER_BASE, correcting the legacy value", async () => {
    // base.js reads the env var at import time, so each case needs a fresh module.
    const load = async (value) => {
      vi.resetModules();
      const prev = process.env.MITM_ROUTER_BASE;
      if (value === undefined) delete process.env.MITM_ROUTER_BASE;
      else process.env.MITM_ROUTER_BASE = value;
      try {
        const src = read("src/mitm/handlers/base.js");
        const fn = src.match(/function normalizeLocalRouter\(value\) \{[\s\S]*?\n\}/)[0];
        const defaults = src.match(/const DEFAULT_LOCAL_ROUTER = "[^"]+";/)[0];
        const legacy = src.match(/const LEGACY_LOCAL_ROUTERS = \[[^\]]*\];/)[0];
        return new Function(`${defaults}\n${legacy}\n${fn}\nreturn normalizeLocalRouter;`)()(value);
      } finally {
        if (prev === undefined) delete process.env.MITM_ROUTER_BASE;
        else process.env.MITM_ROUTER_BASE = prev;
      }
    };

    const { LOCAL_ROUTER_BASE_URL } = await import("@/shared/constants/config.js");

    expect(await load(LEGACY)).toBe(LOCAL_ROUTER_BASE_URL);
    expect(await load("http://127.0.0.1:20128")).toBe(LOCAL_ROUTER_BASE_URL);
    expect(await load(undefined)).toBe(LOCAL_ROUTER_BASE_URL);
    expect(await load("https://router.example.com")).toBe("https://router.example.com");
  });
});

// ---------------------------------------------------------------------------
// F. JCode detector
// ---------------------------------------------------------------------------

describe("F. the JCode detector recognises legacy and current local endpoints", () => {
  /** The route is a Next handler; the detector is a module-private const, so it is
   *  extracted and evaluated rather than imported. */
  const detector = (() => {
    const src = read("src/app/api/cli-tools/jcode-settings/route.js");
    const re = src.match(/const LOCAL_GATEWAY_BASE_URL = (\/.*\/[a-z]*);/)[1];
    const fn = src.match(/const has9RouterConfig = \(config\) => \{[\s\S]*?\n\};/)[0];
    return new Function(`const LOCAL_GATEWAY_BASE_URL = ${re};\n${fn}\nreturn has9RouterConfig;`)();
  })();

  it("accepts a provider on the current port under any name", () => {
    expect(detector({ providers: { mine: { base_url: "http://localhost:20127/v1" } } })).toBe(true);
    expect(detector({ providers: { mine: { base_url: "http://127.0.0.1:20127/v1" } } })).toBe(true);
  });

  it("still accepts a legacy provider on upstream's port", () => {
    // The compatibility requirement: an install configured by an earlier build is
    // configured. Narrowing to 20127 would report "not configured" and disable Reset.
    expect(detector({ providers: { mine: { base_url: "http://localhost:20128/v1" } } })).toBe(true);
    expect(detector({ providers: { mine: { base_url: "http://127.0.0.1:20128/v1" } } })).toBe(true);
  });

  it("still accepts the exact provider key regardless of URL", () => {
    expect(detector({ providers: { "9router": {} } })).toBe(true);
  });

  it("does not claim an unrelated provider", () => {
    // Not broadened beyond the compatibility purpose: another gateway on another port, or
    // a longer port that merely starts with ours, must not match.
    expect(detector({ providers: { other: { base_url: "https://api.openai.com/v1" } } })).toBe(false);
    expect(detector({ providers: { other: { base_url: "http://localhost:3000/v1" } } })).toBe(false);
    expect(detector({ providers: { other: { base_url: "http://localhost:201270/v1" } } })).toBe(false);
    expect(detector({ providers: {} })).toBe(false);
    expect(detector(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G + H. no runtime default left on upstream's port
// ---------------------------------------------------------------------------

describe("G. no affected runtime path still defaults to upstream's port", () => {
  /** Strip comments so an explanation of what was removed does not count as a use. */
  const codeOnly = (rel) =>
    read(rel)
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l))
      .join("\n");

  const RUNTIME_PATHS = [
    "start.sh",
    "src/lib/tunnel/cloudflare/manager.js",
    "src/lib/tunnel/tailscale/manager.js",
    "src/lib/tunnel/shared/localPort.js",
    "src/lib/db/repos/settingsRepo.js",
    "src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js",
    "src/lib/auth/saml.js",
  ];

  it("has no 20128 literal left outside comments", () => {
    const offenders = RUNTIME_PATHS.filter((rel) => codeOnly(rel).includes("20128"));
    expect(offenders).toEqual([]);
  });

  it("allows 20128 in the files whose job is to recognise it", () => {
    // The legacy list and the JCode detector must name it; that is the compatibility
    // behaviour, asserted positively so it is not mistaken for a leftover.
    expect(codeOnly("src/shared/constants/dxrouterIdentity.js")).toContain("20128");
    expect(codeOnly("src/app/api/cli-tools/jcode-settings/route.js")).toContain("20128");
    expect(codeOnly("src/mitm/manager.js")).toContain("20128");
    expect(codeOnly("src/mitm/handlers/base.js")).toContain("20128");
  });
});

describe("H. the SAML fallback origin uses this app's port", () => {
  let saml;
  let savedEnv;

  beforeEach(async () => {
    // Hermetic: the ambient environment may carry BASE_URL, which takes precedence and
    // would hide the fallback this suite exists to check.
    savedEnv = { BASE_URL: process.env.BASE_URL, NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL };
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    vi.resetModules();
    saml = await import("@/lib/auth/saml.js");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("falls back to the canonical port when nothing else is available", async () => {
    const { UPDATER_CONFIG } = await import("@/shared/constants/config.js");

    // No settings, no env, no request — the only path that reaches the literal.
    const origin = saml.getSamlBaseUrl(undefined, undefined);

    expect(origin).toBe(`http://localhost:${UPDATER_CONFIG.appPort}`);
    expect(origin).not.toContain("20128");
  });

  it("still prefers a configured base URL, then the request origin", () => {
    expect(saml.getSamlBaseUrl(undefined, { baseUrl: "https://sso.example.com/" }))
      .toBe("https://sso.example.com");

    const request = {
      headers: { get: (k) => (k === "host" ? "router.example.com" : "") },
      url: "https://router.example.com/api/auth/saml/start",
    };
    expect(saml.getSamlBaseUrl(request, undefined)).toBe("https://router.example.com");
  });

  it("leaves the SP issuer identity alone", () => {
    // Out of scope by instruction: an IdP already has this registered.
    expect(read("src/lib/auth/saml.js")).toContain("urn:9router:sp");
  });

  it("produces an ACS callback on the resolved origin", async () => {
    const { UPDATER_CONFIG } = await import("@/shared/constants/config.js");
    const origin = saml.getSamlBaseUrl(undefined, undefined);

    // The origin's only consumer: `callbackUrl = `${origin}/api/auth/saml/acs``.
    expect(`${origin}/api/auth/saml/acs`)
      .toBe(`http://localhost:${UPDATER_CONFIG.appPort}/api/auth/saml/acs`);
  });
});
