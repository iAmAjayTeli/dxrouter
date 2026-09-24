import pkg from "../../../package.json" with { type: "json" };
import { DXR_DEFAULT_APP_PORT, DXR_IDENTITY } from "./dxrouterIdentity.js";

// App configuration
export const APP_CONFIG = {
  name: `${DXR_IDENTITY.displayName} Proxy`,
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: DXR_IDENTITY.changelogUrl,
  /**
   * Upstream 9Router's donation endpoint, inherited with the fork and deliberately kept.
   *
   * It is not an update channel: no version, package or code is fetched through it. It is
   * a funding link, and `DonateModal.js` fetches it to render the panel's contents. The
   * alternatives were both worse than keeping it — removing it breaks a working feature
   * this milestone has no mandate to change, and pointing it at a DXRouter endpoint would
   * invent a URL that does not exist and break the modal differently.
   *
   * Two things a future reader should know rather than re-derive. It is the one remaining
   * upstream URL in this file, pinned by name in
   * `tests/unit/dxr-updater-identity.test.js` so a second cannot appear unnoticed. And it
   * is an outbound call to infrastructure this project does not operate, which sits
   * against FINAL-ARCHITECTURE §14.2 ("nothing leaves the machine") — it fires only when
   * the operator opens the donate modal, so it is user-initiated rather than telemetry,
   * but whoever gives DXRouter its own funding link should replace this and delete this
   * comment.
   */
  donateUrl: "https://9router.com/api/donate",
};

// Updater configuration.
//
// Reduced to the one field that is still a fact. The package name, install commands,
// status port and install/wait tuning all described a self-install path that no longer
// exists: DXRouter publishes no release channel, so its routes refuse to update and
// there is no command to offer (see `@/shared/constants/dxrouterIdentity`). Anything
// reinstating a package name here would have to come with a real release channel and a
// proof that the target is DXRouter's — `npm i -g dxrouter` currently resolves to an
// unrelated npm package.
export const UPDATER_CONFIG = {
  /** Default loopback port. The port an instance actually bound is `PORT` — resolve it
   * with `@/lib/dxrInstallation`'s `resolveOwnPort()` rather than reading this. */
  appPort: DXR_DEFAULT_APP_PORT,
};

// Re-exported from the identity leaf so UI code keeps one import path. They are defined
// there, not here, because the database layer needs them and must not pull in the provider
// and model catalogue this module re-exports below.
export {
  LOCAL_ROUTER_BASE_URL,
  LEGACY_LOCAL_ROUTER_BASE_URLS,
  normalizeLocalRouterBaseUrl,
} from "./dxrouterIdentity.js";

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // Free and Plus Codex accounts both expose gpt-5.5; avoid fallback probes that waste requests.
      pingModel: "gpt-5.5",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
