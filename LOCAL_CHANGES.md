# Finn OpenClaw frozen base

This branch is the authoritative OpenClaw source base for Finn and Jake. It is
frozen at source commit `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`,
corresponding to the `2026.7.1` source used by the installed
`openclaw@2026.7.1-2` runtime.

## Ownership

- This repository is persistent and locally authoritative.
- `/Users/aiapi/workspace/openclaw-upstream` is the only disposable upstream
  mirror. Weekly maintenance may hard-reset and clean that mirror.
- Weekly maintenance must never merge, rebase, reset, or otherwise mutate this
  frozen repository.
- `local-overlay/` contains the complete durable patch registry currently
  applied historically to Finn and packaged for Jake. Current turn-lifecycle
  behavior is source-integrated; old compiled patches are retained as rollback
  evidence and are not layered over a source-integrated build.
- The canonical deployable artifact and its SHA-256 are recorded in
  `OPENCLAW_FREEZE.json`. Large runtime artifacts remain outside Git.

## Selected upstream integration

An upstream change is integrated only after the user selects it from a weekly
audit report. Create a candidate branch from this frozen branch, port or
cherry-pick the selected change, reconcile every overlapping local change,
and run the targeted plus full regression suites. Do not change the canonical
artifact, freeze manifest, Finn, Jake, or the stable update manifest until the
candidate has a written compatibility report and explicit promotion approval.

Direct fast-forwarding from upstream, automatic dependency upgrades, and
runtime-bearing agent updates are prohibited.

## Source-integrated behavioral contract

`turn-lifecycle-v53` is implemented in the frozen source and verified before
packaging. It provides typed yield/resume ownership, durable continuation
state, evidence-backed completion, failed-tool and accidental-silence recovery,
mutation replay protection, bounded subagent orchestration, dynamic
parent-fork context sizing, and TUI terminal-history reconciliation.

Generated natural-language phrases are not production control inputs. Exact
phrases may appear in regression fixtures or protocol sentinels only.

Every source-built artifact must:

1. come from a clean reviewed commit;
2. be stamped with that commit and behavior contract;
3. pass the affected source suites, full build, package verifier, and Alistar
   certification before Finn/Jake promotion;
4. update `OPENCLAW_FREEZE.json` only after the artifact hash and runtime tree
   hash are final.
