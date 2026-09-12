/**
 * The cache pricing model (§9.2, §9.3).
 *
 * One door, four files behind it: a flat-subset YAML reader, the record schema and its
 * validation, a filesystem/memory source abstraction, and the loader that turns a
 * directory of records into a registry with a version and a diagnostic per provider.
 *
 * The loader never throws. Every failure mode in the §9.3 table ends with a routable
 * provider and a recorded reason, because a bad pricing file must degrade one provider's
 * cache-awareness and nothing else.
 */

export {
  PRICING_STATUS,
  DISABLED_CAUSE,
  PRICING_LABELS,
  MECHANISMS,
  VERIFICATION_METHODS,
  toBasisPoints,
  parseVerifiedAt,
  validateCacheModel,
  disabledCacheModel,
  supportsConfirmedArithmetic,
} from "./schema.js";
export { parseFlatYaml, YamlError } from "./yaml.js";
export { createDirectorySource, createMemorySource, shippedSource, layerSources } from "./source.js";
export {
  REQUIRED_PROVIDERS,
  DEFAULT_PROVIDER_KEY,
  cacheModelVersion,
  loadCacheModels,
  describePricing,
} from "./loader.js";
export { default } from "./loader.js";
