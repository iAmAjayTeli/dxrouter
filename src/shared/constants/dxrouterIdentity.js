/**
 * The canonical DXRouter identity — the single source for "who is this product".
 *
 * The version check and the update path both derive their target from here. Nothing on
 * that path may name a package, repository or port of its own: a second copy of the
 * upstream package name is exactly how this fork would silently start updating 9Router
 * instead of itself, and `tests/unit/dxr-updater-identity.test.js` fails if one appears.
 *
 * Pure constants — no `node:` builtins — because `./config.js` re-exports from here and
 * is imported by client components, so this module is bundled for the browser too.
 *
 * Deliberately NOT here: the data-root directory name. That stays `9router`
 * (`src/lib/dataDir.js`) because renaming it would orphan every existing install's
 * credentials and usage history (see the M0 note there). Where an install keeps its
 * data and what product it updates are separate questions.
 */

/**
 * Upstream 9Router. Recorded so the fork relationship is documented and testable — it is
 * never a target. The only reason this literal exists anywhere in the update path is so
 * that `tests/unit/dxr-updater-identity.test.js` can assert the fork still knows what it
 * must not become.
 */
const UPSTREAM_IDENTITY = Object.freeze({
  packageName: "9router",
  repository: "https://github.com/decolua/9router.git",
});

export const DXR_IDENTITY = Object.freeze({
  project: "dxrouter",
  packageName: "dxrouter",
  displayName: "DXRouter",
  repository: "https://github.com/iAmAjayTeli/dxrouter.git",
  /** GitHub Releases API for the DXRouter repository. The only version source. */
  releasesApi: "https://api.github.com/repos/iAmAjayTeli/dxrouter/releases/latest",
  releasesPage: "https://github.com/iAmAjayTeli/dxrouter/releases",
  changelogUrl: "https://raw.githubusercontent.com/iAmAjayTeli/dxrouter/refs/heads/master/CHANGELOG.md",
  upstream: UPSTREAM_IDENTITY,
});

/**
 * Loopback port a DXRouter instance listens on by default. The port an instance actually
 * bound comes from `PORT` at runtime — `@/lib/dxrInstallation` resolves it, and nothing
 * may assume this default when asking "is our server still up".
 *
 * Upstream's default (20128) is intentionally absent: it belongs to a separate install
 * that may be running on the same machine, so treating it as ours would make each
 * installation probe and terminate the other.
 */
export const DXR_DEFAULT_APP_PORT = 20127;

/**
 * Where something on this machine reaches DXRouter's own OpenAI-compatible API.
 *
 * Used as the default "MITM router base": the MITM child process forwards intercepted tool
 * traffic back into the router through this URL. It was `http://localhost:20128`, upstream
 * 9Router's port — so on a host running both, intercepted requests either hit nothing or
 * were silently answered by the *other* installation while carrying a DXRouter API key.
 *
 * Lives here rather than in `./config.js` because the database layer needs it:
 * `settingsRepo.js` imports it on the DB-init path, and `config.js` re-exports the whole
 * provider and model catalogue, which has no business being pulled in there.
 */
export const LOCAL_ROUTER_BASE_URL = `http://localhost:${DXR_DEFAULT_APP_PORT}`;

/**
 * Loopback router bases that were the inherited default rather than a choice.
 *
 * Deliberately only the loopback spellings of upstream's port. A remote
 * `http://some-host:20128` is somebody's actual deployment and is left alone; a *local*
 * 20128 cannot be a considered decision for this product, because 20127 is where it
 * listens. That distinction is what lets `normalizeLocalRouterBaseUrl` correct the stale
 * default without touching a custom URL.
 */
export const LEGACY_LOCAL_ROUTER_BASE_URLS = Object.freeze([
  "http://localhost:20128",
  "http://127.0.0.1:20128",
]);

/**
 * The effective router base for a stored setting.
 *
 * Read-time normalisation, not a database rewrite. The value is persisted on every MITM
 * start, so existing installs already hold the inherited default and changing the default
 * alone would never reach them; rewriting the row instead could clobber a deliberate custom
 * URL. Correcting on read fixes both without writing anything.
 *
 * Anything that is not an exact legacy loopback default is returned as given (trimmed,
 * trailing slashes dropped), so a custom router survives untouched.
 */
export function normalizeLocalRouterBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return LOCAL_ROUTER_BASE_URL;
  return LEGACY_LOCAL_ROUTER_BASE_URLS.includes(trimmed.toLowerCase())
    ? LOCAL_ROUTER_BASE_URL
    : trimmed;
}

/**
 * How this installation was obtained. Answered by `@/lib/dxrInstallation`, which proves
 * the source-checkout case against the git remote rather than assuming it.
 *
 * There is no `PACKAGED` mode yet on purpose: DXRouter publishes no release channel, so
 * a packaged install cannot be proven to exist and inventing the state would invite
 * code that trusts it. `UNKNOWN` is the fail-closed answer and the update route refuses
 * it.
 */
export const INSTALLATION_MODE = Object.freeze({
  SOURCE_CHECKOUT: "source-checkout",
  UNKNOWN: "unknown",
});

/**
 * No install command constant lives here, and that is the point: self-update is disabled
 * until DXRouter has a release channel, so there is no command the dashboard or CLI
 * could offer that would install the right thing. A constant here would be copied into
 * the UI, and `npm i -g dxrouter` currently resolves to an unrelated npm package.
 */
