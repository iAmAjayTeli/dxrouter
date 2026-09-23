import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { DXR_IDENTITY } from "@/shared/constants/dxrouterIdentity";
import { describeInstallation } from "@/lib/dxrInstallation";

/**
 * Version check against DXRouter's own release source.
 *
 * This route used to ask npm for `9router@latest` and compare it against this checkout's
 * `package.json`. Both halves were upstream's identity, so on a fork pinned at the
 * upstream v0.5.60 fork point the comparison was *correct* and the answer was still
 * wrong: DXRouter reported "New version available: v0.5.75", and the update it offered
 * replaced the operator's global 9Router install. The bug was never the comparison — it
 * was the question.
 *
 * So the question is now DXRouter's: its own GitHub Releases. Nothing here reads the npm
 * registry, and an upstream release is not merely "not newer" — it is not an input.
 *
 * Fail-closed at every step. A 404 (no DXRouter release exists yet), a rate limit, a
 * timeout, a malformed body, an unparseable tag: all report unavailable with
 * `hasUpdate: false`, because an update prompt the operator cannot act on is worse than
 * no prompt.
 */

const RELEASE_TIMEOUT_MS = 4000;
const RESULT_TTL_MS = 3600000; // a real release is worth caching for an hour
const FAILURE_TTL_MS = 300000; // but a transient failure should not hide one that long

/** Survive hot reload; one cache per process. */
const releaseCache = (global.__dxrReleaseCache ??= { value: null, fetchedAt: 0 });

export const VERSION_STATE = Object.freeze({
  UPDATE_AVAILABLE: "update-available",
  CURRENT: "current",
  UNAVAILABLE: "unavailable",
});

const UNAVAILABLE_MESSAGE = "No DXRouter release available";

/**
 * Latest DXRouter release tag, or null when there is none to trust.
 *
 * GitHub rejects requests without a User-Agent, so its absence would look like an
 * outage; that is why it is set explicitly rather than left to the default.
 */
function fetchLatestRelease() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = https.get(
      DXR_IDENTITY.releasesApi,
      {
        timeout: RELEASE_TIMEOUT_MS,
        headers: {
          "User-Agent": `${DXR_IDENTITY.packageName}-version-check`,
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        // 404 is the expected answer while DXRouter has no releases at all; every other
        // non-200 (403 rate limit, 5xx) is equally "cannot prove".
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const tag = String(parsed?.tag_name ?? "").trim().replace(/^v/i, "");
            done(tag || null);
          } catch {
            done(null);
          }
        });
      }
    );

    req.on("error", () => done(null));
    req.on("timeout", () => {
      req.destroy();
      done(null);
    });
  });
}

/** Numeric triple, or null if this is not one. Never guess at a version string. */
function parseVersion(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0; // uncomparable ⇒ no update claimed
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestReleaseCached() {
  const fresh = Date.now() - releaseCache.fetchedAt;
  if (releaseCache.value && fresh < RESULT_TTL_MS) return releaseCache.value;
  if (!releaseCache.value && releaseCache.fetchedAt && fresh < FAILURE_TTL_MS) return null;

  const latest = await fetchLatestRelease();
  releaseCache.value = latest;
  releaseCache.fetchedAt = Date.now();
  return latest;
}

export async function GET() {
  const install = describeInstallation();
  const currentVersion = pkg.version;
  const latestVersion = await getLatestReleaseCached();
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  const state = !latestVersion
    ? VERSION_STATE.UNAVAILABLE
    : hasUpdate
      ? VERSION_STATE.UPDATE_AVAILABLE
      : VERSION_STATE.CURRENT;

  return Response.json({
    currentVersion,
    latestVersion,
    hasUpdate,
    state,
    /**
     * Why no update can be offered right now. Shown verbatim in the dashboard, so it
     * carries no local paths or origins — the operator's own machine layout is not a
     * thing this API needs to describe.
     */
    message: state === VERSION_STATE.UNAVAILABLE ? UNAVAILABLE_MESSAGE : null,
    /** Provenance, for the dashboard to explain what kind of install this is. */
    mode: install.mode,
    installMessage: install.message,
    /** No mode can self-update today; see `@/lib/dxrInstallation`. */
    canSelfUpdate: install.selfUpdateAvailable,
    releaseSource: DXR_IDENTITY.releasesPage,
  });
}
