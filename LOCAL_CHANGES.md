# Finn OpenClaw frozen base

This branch is the authoritative OpenClaw source base for Finn and Jake. The
current promoted freeze revision is source commit
`2f4e192f1df3d9922e140f8fec87eab835a403ff`, packaged as
`2026.7.1-30`. The prior frozen commit
`6b1ccfd1b2dfa4a95d1a250acc0eb53c7c427cb3` remains available at rollback ref
`freeze-rollback-20260814-6b1ccfd`.

## 2026-08-14 hardening freeze promotion: 2f4

This is a canonical source/artifact revision only. Alistar has not been rebooted,
provisioned, or used for live-model certification at this point.

- Previous frozen source: `6b1ccfd1b2dfa4a95d1a250acc0eb53c7c427cb3`.
- Promoted source: `2f4e192f1df3d9922e140f8fec87eab835a403ff`, an ancestry-preserving
  fast-forward on `feature/hardening-governor-v1-20260810`.
- Rollback ref: `freeze-rollback-20260814-6b1ccfd`.
- Core artifact: `openclaw-2026.7.1-29-candidate.2f4e192f.tgz`, SHA-256
  `f379d622eb2a08fffde1b5112d5095e88e919948804203792e415f218867ab90`.
- Matching memory artifact: `openclaw-memory-lancedb-2f4e192f1df3.tgz`, SHA-256
  `3afe89d640c022a134315445cfd68c50a0ffa36a6fce9ab89c3aca77ac469bd7`.
- Runtime JS SHA-256: `4628c9fb44ddb933ead1630129d2582af24c019c75fa695f5a4376d0fdbd77f3`.
- Runtime tree SHA-256: `deede5de077e03f1420ca91634eeac11935f322c49e948f7f5f640506154a3fa`.
- Previous manifest SHA-256: `c538c435df1b2610831b076a7da31b9f51a399ce34f86084bb766b66ad72339c`.

The promoted source includes the reviewed governor ingress/tool-authority,
lifecycle, child-intent, receipt, cancellation, restart-fence, provider-start,
compaction, and process-boundary changes represented by the pushed chain ending
at 2f4. Exact pushed milestones included in or ancestral to the promoted source
are:

- `49af3661776534db4c7ad7977862e303321d4773` (spawn failure containment).
- `1a3fea6708755af359bcd2286d31b1f3f512e71e` (production process-boundary harness).
- `2d7d956920b7b5c60aeee48a10767a73d296dd6e` (governed child dispatch CLI lifecycle).
- `2e2f960073a5900d525c5a168de0fc375059fa4f` (child crash/identity matrix).
- `8e20c429950541c8057a023fe99db62a7a558a58` (Gateway restart fence matrix).
- `28553b7283d7bc6152b7753982d1f58e9545035f` (receipt-bound cancellation).
- `21cc9e5e02746801053cdeda9dc2367946393aff` (cancelled replay fencing).
- `7f95c97c28b0af2c6f0d11f30d71c93c6aa7e567` (failed child provider-start fence).
- `2f4e192f1df3d9922e140f8fec87eab835a403ff` (restart fences and compaction).

The full source commit and artifact hashes are authoritative in the freeze
manifest; Grond fake-provider/process evidence remains supplemental only.

Bugs found and resolved in this promotion work included the need to fetch the
exact approved source object into the canonical clone before ancestry checking,
noninteractive dependency setup rejecting an initial node_modules symlink in the
isolated candidate, and a metadata-only manifest writer type error. The latter
did not alter the built artifacts; the final metadata and both package hashes
were rechecked before promotion.

### C01-C13 status at this freeze boundary

The following status distinguishes source/deterministic implementation evidence
from countable live certification:

| Criterion | Status |
| --- | --- |
| C01 | Source/deterministic coverage present; live countability pending Alistar/Qwen smoke and review. |
| C02 | Remaining: terminal final-response-only phase and campaign evidence. |
| C03 | Source/deterministic coverage present; live countability pending. |
| C04 | Source/deterministic coverage present; live countability pending. |
| C05 | Remaining: durable retry plan/checkpoint semantics and campaign evidence. |
| C06 | Source/deterministic coverage present; live countability pending. |
| C07 | Remaining: real memory-backend adapter/invalidation/retention integration; synthetic store evidence is not countable. |
| C08 | Source/deterministic coverage present; live countability pending. |
| C09 | Source/deterministic coverage present; live countability pending. |
| C10 | Remaining: authorized live integration/campaign evidence. |
| C11 | Source/deterministic coverage present; live countability pending. |
| C12 | Remaining: signed host close/abort receipt and restart/recovery evidence. |
| C13 | Source/deterministic coverage present; live countability pending. |

Grond fake-provider and process-boundary results remain supplemental prerequisite
evidence only. They are not actual-Qwen, Alistar, or production certification.
The remaining work is C02, C05, C07, C10, C12, final independent review, and the
100x live campaign. The next gate is read-only provisioner preflight against this
manifest; no Alistar mutation is implied by this freeze commit.

## 2026-08-14 freeze compatibility correction: numeric runtime 2f4

The first wrapper commit `1402eb7426621f9bec78785b86fd13726f265c64` used the
unique suffix `2026.7.1-29-candidate.2f4e192f`. Frozen package hashing and
provisioner resolution passed, but the installed product rejected its paired
memory plugin because the plugin API gate compares the runtime prerelease form
against `>=2026.7.1`. No gateway started and no live smoke ran. The corrective
wrapper keeps the exact same source/build and uses the established numeric
runtime form `2026.7.1-30`.

- Corrective source: `2f4e192f1df3d9922e140f8fec87eab835a403ff` (unchanged).
- Corrective core artifact SHA-256:
  `00d9fda5125510b8762eb5e1946983098baeb87696767a769954a459d7db60a4`.
- Corrective memory artifact SHA-256:
  `3afe89d640c022a134315445cfd68c50a0ffa36a6fce9ab89c3aca77ac469bd7`.
- Corrective runtime tree SHA-256:
  `5807b2fc96f8a37bae5035df43d651853a8578f39c36589f2d15f3e306a2a7fe`.
- Superseded wrapper: `1402eb7426621f9bec78785b86fd13726f265c64`; its artifact remains
  outside the canonical path for audit and is not a deployable freeze.
- The fresh install was stopped at plugin compatibility; no gateway/provider
  process or live-model request was created.

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
