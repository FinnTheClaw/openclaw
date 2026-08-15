---
title: "Functional Finn"
summary: "Isolated plan and evidence tracker for native Goal admission, verified memory, and fail-closed answer release"
read_when:
  - You are reviewing the isolated Functional Finn plugin
  - You need to distinguish this work from behavior-governor hardening
---

## Status

Candidate implementation under deterministic review. No production enablement has occurred.

This plan is independent from behavior-governor work. It does not own plan execution, tool scheduling,
child orchestration, task-flow control, efficiency budgets, or completion governance.

## Audit conclusions

- The installed runtime contains native Goal tools, but the default prompt requires explicit user
  requests, so ordinary substantive turns did not create goals.
- Durable task mirrors exist, but no managed flow controller owned ordinary conversations. Functional
  Finn therefore uses the native session Goal contract and does not add a managed TaskFlow.
- Native rolling loop detection exists but was not enabled in the audited effective configuration.
- The bundled Memory Wiki was disabled, lacked one runtime dependency, and did not expose the newer
  per-agent vault scope. It cannot satisfy per-agent isolation as installed.
- The active vector-memory plugin provided recall/store/forget tools, while builtin memory was disabled.
  A safe cutover requires quarantine or selective import from provenance-proven records; arbitrary
  vector rows must not become verified builtin memory.
- The channel finalize hooks are fail-open. Physical channel delivery is the enforcement point for a
  signed release receipt; hook failure alone cannot authorize delivery.
- Sanitized recent-run metadata showed both zero-tool turns and long tool loops. The problem was not a
  universal inability to call tools. No raw messages, tool arguments, results, or response bodies are
  retained in this tracker.

## Requirement ledger

1. **Preserve runtime and local-model route:** audited; candidate is isolated and production is unchanged.
2. **Explain missing native behavior:** complete from version, config, plugin, tool-policy, task-mirror,
   loop, and sanitized session metadata.
3. **Automatic durable Goal:** implemented with an atomic native session `ensure` operation. Trivial
   acknowledgements remain lightweight; active goals are reused and completed goals are replaced.
4. **Rolling loop detection:** native configuration selected; isolated canary and multi-tool/loop proof
   remain pending.
5. **Per-agent wiki backed by builtin memory:** verified-record materializer implemented. Safe
   vector-memory backup/quarantine, builtin-memory activation, and indexed recall proof remain pending.
6. **Memory admission:** implemented for host-issued user/tool/authoritative evidence with exact spans and
   independent semantic support. Raw spans are bounded process-memory evidence and never enter plugin
   SQLite state; model inference alone is rejected.
7. **Structured answer envelope:** implemented with atomic claims, evidence spans, freshness,
   observed/inferred classification, confidence, and abstention.
8. **Fail-closed channel release:** candidate verifier client/server, one-revision policy, Ed25519 receipt,
   durable delivery reservation, and Signal physical-send check implemented. Pinned offline model bundle,
   independent review, process-failure proof, and isolated local-model canary remain pending.
9. **Contradiction repair:** generation-based replacement/tombstone and serialized per-agent wiki
   materialization implemented. Existing-memory migration and restart/convergence canary remain pending.

## Deterministic evidence

- Atomic Goal create/reuse/replace and concurrent convergence.
- Substantive/trivial classification and missing-session fail-closed behavior.
- Exact-span, freshness, scope, unsupported-claim, one-revision, abstention, timeout, oversized-frame,
  receipt-tamper, route-binding, durable replay, and physical-send denial tests.
- Memory inference rejection, stale/weaker/cross-scope rejection, idempotent replay, supersession,
  tombstone removal, restart recall, and serialized materialization tests.

## Production gate

Before enablement: create timestamped backups and a syntax-checked rollback script; provision and hash the
offline verifier bundle; test in an isolated state root with the actual configured local model; obtain an
independent P0/P1 review of one exact commit; then verify the selected builtin-memory index, channel route,
no duplicate delivery, and one bounded restart only if hot reload is insufficient.
