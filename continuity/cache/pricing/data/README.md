# Cache pricing records

One file per provider key, read by `../loader.js`. The key is the **filename**, and a
record whose `provider:` disagrees with its filename is rejected — that mix-up is how
one vendor would end up with another vendor's ratios (I4 forbids it).

Every record shipped here was written from **vendor documentation**, not measured in
this workspace: `verification_method: documentation`, and `verified_at` is the date the
documentation was last actually read, not the date the file was written. Because that
date is older than `pricing.max_age` (90 days), the loader reports these records as
`stale` and downgrades every term they produce to `estimated` with the
`cache-model-stale` label. That is the intended state until a human re-verifies them or
the `cache_probe` measure (§19.4, Q1) produces measured values — which is exactly what
`verified_at` / `verified_by` are for.

A provider whose cache economics cannot be stated from documentation ships
`mechanism: none`: zero claimed cache economics (I4), fully routable, visible in the
startup summary. Several of those still set `reports_cache_read: true`, which is not a
contradiction — "the provider tells us when it served a cache read" and "we have a
verified price model for that read" are different facts, and M2 only needs the first.
