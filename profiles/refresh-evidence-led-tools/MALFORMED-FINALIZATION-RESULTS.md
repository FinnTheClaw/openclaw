# Malformed-terminal finalization: live regression check

Date:2026-09-18. Alistar openclaw-refresh-manual; native OpenClaw CLI sessions through moira/brain. Baseline62c83212e3d7f54397491d0339158792a381316c versus candidatec74d3d54ff3934096b910c07270d1e07b3cddc5e. Two existing cases, five fresh repetitions per arm,20 total. Three independent paired lanes; alternating pair order. Same8192 output-token setting, task inputs, fixture contents, plugins and tool schemas. No caller retries or rejected guidance profile.

| Metric                                                    | Baseline62 | Candidatec74 |
| --------------------------------------------------------- | ---------: | -----------: |
| Correct state, scope and materially correct usable answer |      10/10 |        10/10 |
| Append once, preserve seed-001, report line count2        |        5/5 |          5/5 |
| ready to shipped and accurate confirmation                |        5/5 |          5/5 |
| Duplicated completed mutations                            |          0 |            0 |
| Unintended file changes                                   |          0 |            0 |
| Malformed JSON tool arguments                             |          0 |            0 |
| Blank/invalid tool-name rejection observed                |          0 |            0 |
| New malformed-terminal finalization branch exercised      |          0 |            0 |
| Native reasoning-only continuation                        |          0 |            1 |
| HTTP requests                                             |         40 |           41 |
| Wire tool calls                                           |         30 |           30 |
| Median seconds                                            |    14.1965 |      14.7320 |
| Sum of submission seconds, not wall time                  |    141.959 |      174.201 |

All81 captured HTTP responses were assigned to Narya Qwen/Qwen3.8-27B-NVFP4. The runtime requests continued to use the canonical moira/brain alias; no physical model name was added to OpenClaw configuration.

Root reviewed every final answer against the after-state and tool calls. Each run performed exactly one requested mutation. Candidate r05-R20 recovered an initial reasoning-only stop before any tool execution, then located/read/updated/read back the file and accurately answered. This exercised pre-existing continuation, NOT the new malformed-tool finalizer. Baseline r05-R20 did not read back after writing, but did not falsely claim a readback; its state claim matches the resulting file.

## Decision and limits

Live regression check PASS. Incremental reliability improvement NOT ESTABLISHED by this cohort, because both arms succeeded and the new malformed-terminal branch never activated. No speedup claim; observed candidate cost was higher, but this small stochastic run does not isolate a causal overhead from the inactive new branch.

The earlier exact malformed-terminal source regression failed before the correction and passed after it; the92 focused source checks are separate deterministic evidence, not extra live submissions. The correction remains experimental/unpromoted. Do not label this as a100-case campaign,100% model reliability, or production acceptance.

No new source change was warranted by this20-submission run. No production Finn, normal Alistar gateway, PXE, coordinator/model settings, or persistent storage configuration changed. The inference reservation was released on completion.

## Evidence

Grond report root: /backup/finnclaw_workspace/openclaw-refresh/reports/reliability-resume-20260918/

- malformed-finalization-evidence-final.json: compact per-run state, answer, calls, frames and event projection.
- malformed-finalization-paired/: archived raw body captures, prompts, before/after files, records and manifests; protected config/state files excluded.
- Alistar original: /home/finnclaw/reliability-resume-20260918/malformed-finalization-paired
- Source runner: upstream/profiles/refresh-evidence-led-tools/compare-malformed-finalization.py
- Runtime sourcec74 remains distinct from later documentation commits.

The durable compact evidence was published without replacing any existing target; raw archive extraction also retained existing files. No GitHub push was attempted.
