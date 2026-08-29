# C04b aggregate-order current-lineage campaign

## Status

This is an inert test-corpus preparation, not a governor module or a release candidate. It does
not change runtime registration, configuration, artifact delivery, or deployment. C04b remains
blocked until the feature-neutral governed-run consumer is independently GO on the current
skeleton lineage.

The exact prior reconstruction (`6193cbde067b35dc7b7fb1781015f4627fd0fb39`) cannot be reused:
its selected module relies on an optional host factory that production does not supply and starts
the broad legacy lifecycle. Its blocker is recorded in `2026-08-27-c04b-modular-binding-no-go.md`.

## Fixed behavior under test

For a C04b-selected run, the aggregate/synthesis operation is rejected until each of the three
required observation criteria has a successful, current, scope-matched result. It is admitted
only after the final required successful observation. The test does not claim C04a exact-cohort
completeness, C05 replanning, C06 final delivery, or any other feature.

## Delivery requirements after the skeleton seam exists

The eventual C04b module must be one catalog entry selected by exact id, version, mode, and
artifact identity. It must receive only the narrow aggregate-order capability from the
production-owned consumer. It must not construct, configure, or close the legacy governor
lifecycle; it must have no import-time effect; `modules: []` must remain observably inert. The
actual capability type and delivery-map entry are intentionally deferred to the reviewed skeleton
seam rather than guessed here.

## Deterministic source gate

`c04b-aggregate-order-campaign.test.ts` validates that the corpus has exactly 100 unique prompts
and ids, twenty cases for each phase, three distinct required criteria, a rejected early aggregate
attempt, and explicit retry/restart/final-concurrency stress cases. This only validates campaign
data; it is not source or installed-behavior certification.

## Alistar acceptance protocol

1. Reboot via the unchanged PXE path and state-preservingly reprovision a fresh Alistar agent with
   the exact signed C04b artifact. Use the installed agent, configured coordinator route, and real
   local Qwen backend; no mocked provider response, replay, or provider shim qualifies.
2. Run each corpus case once through a dedicated no-side-effect test scope and supplied observation
   tool. Capture the installed artifact digest, request id, correlation id, selected model/backend,
   module selection, ordered criterion events, aggregate admission decision, and result for every
   case.
3. A case passes only if every pre-final aggregate attempt is rejected, all required successful
   observations precede admission, and the first admitted aggregate occurs after the third required
   success. Retry cases must not count a failed observation; restart cases must preserve the
   pre-restart order; concurrent-final cases must not admit before both final completions commit.
4. Require 100/100 passes, corroborating coordinator/backend evidence for every request, no
   unexpected gateway/coordinator error, and Alistar memory samples before/during/after. On any
   failure, preserve the exact artifact and trace, roll the module back to development, and do not
   promote it or alter the production ledger.
