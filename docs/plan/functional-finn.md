---
title: "Functional Finn"
summary: "Isolated plan and evidence tracker for native Goal admission, verified memory, and fail-closed answer release"
read_when:
  - You are reviewing the isolated Functional Finn plugin
  - You need to distinguish this work from behavior-governor hardening
---

## Status

Candidate source is under correction after two exact-object reviews. No live install, service/config
mutation, Signal change, or certification has occurred.

- `4040cf65cffaba8e590198349fa94a4be14994e2`: **NO-GO**, 1 P0 / 3 P1.
- `f241d5a61b07c74a71d772003901886bca113397`: **NO-GO**, 2 P0 / 8 P1.

The current uncommitted source includes the TypeScript submit/pull-only protected Signal adapter and a
real adapter-level fail-closed fence for fail-open hook timeout/error paths. Those pieces are
source-complete, not independently reviewed GO and not installed.

This plan is independent from behavior-governor work. It does not own plan execution, tool scheduling,
child orchestration, TaskFlow control, task/subagent authority, tool-loop control, efficiency budgets,
or completion governance. Functional Finn must not acquire any of those authorities.

## Exact `f241d5a6` finding ledger

| Severity | Finding                                                                                  | Consolidated owner                 | Functional Finn items |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------- | --------------------- |
| P0       | Public notice flags could mint a release bypass.                                         | Signal/revision delivery           | 7, 8                  |
| P0       | A same-UID verifier socket exposed a signing oracle instead of an independent authority. | Two-daemon external authority      | 8                     |
| P1       | The revision store was evictable, weakening one-revision and replay state.               | Signal/revision delivery           | 7, 8                  |
| P1       | Delivery rows were evictable, weakening idempotency and terminal history.                | Signal/revision delivery           | 8                     |
| P1       | An unknown Signal RPC outcome could be marked sent.                                      | Signal/revision delivery           | 8                     |
| P1       | Protected replies could be chunked after validation.                                     | Signal/revision delivery           | 7, 8                  |
| P1       | TypeScript and Python canonical encodings could disagree.                                | Two-daemon external authority      | 7, 8                  |
| P1       | The builtin-memory projection path and migration were unsafe.                            | Builtin-memory projection/evidence | 6, 9                  |
| P1       | Projection startup/close failures were not fail-visible or bounded.                      | Builtin-memory projection/evidence | 6, 9                  |
| P1       | Evidence could be serialized before its byte bound was enforced.                         | Builtin-memory projection/evidence | 6, 7, 9               |

The corrections are intentionally consolidated into three roots: Signal/revision delivery owns final
payload identity and durable outcomes; builtin-memory projection/evidence owns bounded verified memory
and contradiction repair; and the two-daemon external authority owns independent validation, signing,
and physical Signal capability. None is a planner or execution governor.

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
   durable delivery reservation, TypeScript submit/pull-only protected adapter, and adapter-level
   hook-timeout/error hard fence are source-complete. Independent review and deployment proofs remain
   pending.
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

The remaining blockers are:

1. exact-object independent GO;
2. pinned isolated HHEM bundle;
3. dedicated `_finnrel`/`_finnsig` UID and launchd installation proof;
4. `_finnsig` operation with the Signal linked-device credentials;
5. revocation of the old OpenClaw-owned linked device;
6. negative proof that `_openclaw` cannot read credentials/keys or reach any physical-send path;
7. timestamped backups and a syntax-checked rollback procedure; and
8. an isolated canary using the actual local Qwen route.

Until every blocker closes, this remains source work only: no live installation, production enablement,
or certification is claimed.
