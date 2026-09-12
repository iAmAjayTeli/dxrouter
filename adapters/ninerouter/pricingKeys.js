/**
 * `pricingKeys` — the 9Router provider alias → §9.2 vendor pricing key map.
 *
 * Split out of `cacheObserver.js` for one mechanical reason: `cacheObserver` imports
 * `normalizeUsage` from `executorAdapter.js`, which imports `open-sse`, which is a
 * bundler/vitest alias and does not resolve under bare node. The `dxrouter` CLI (§13)
 * runs under bare node and needs this map to know which vendor a fixture or a recorded
 * result is priced against. A map is not a reason to drag the routing engine into a CLI.
 *
 * Only aliases whose upstream is the vendor's own API at the vendor's own cache semantics
 * appear here. Notable deliberate omissions: `codex` (OpenAI's Codex/ChatGPT backend, not
 * the platform API), `gemini-cli` and `antigravity` (Google surfaces with their own quotas
 * and caching), and every aggregator or subscription proxy. Those take the §9.3 "no
 * pricing record" path on purpose: `registry.get` resolves the `default` record
 * (`mechanism: none`) and the route contributes zero claimed cache economics (I4).
 *
 * Guessing — `codex` → openai, `gemini-cli` → google — is exactly the "silently fall back
 * to another provider" the invariants forbid, because those aliases reach different
 * endpoints with different cache behaviour under a familiar-looking name.
 */

/** 9Router provider alias → §9.2 vendor pricing key. */
export const PRICING_KEY_BY_ALIAS = Object.freeze({
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gemini: "google",
  deepseek: "deepseek",
  groq: "groq",
  xai: "xai",
  mistral: "mistral",
  together: "together",
  fireworks: "fireworks",
  cerebras: "cerebras",
});

/** The vendor pricing key for a 9Router provider alias, or null when unmapped. */
export function pricingKeyForProvider(provider) {
  const alias = String(provider ?? "").trim().toLowerCase();
  return PRICING_KEY_BY_ALIAS[alias] ?? null;
}

export default pricingKeyForProvider;
