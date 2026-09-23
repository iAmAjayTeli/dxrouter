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
