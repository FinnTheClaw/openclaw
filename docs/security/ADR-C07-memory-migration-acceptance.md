# C07 normative migration, rollback, and acceptance plan

Status: proposed companion to `ADR-C07-memory-authority-redesign.md`. Implementation remains blocked
until all C07 design records receive an independent GO.

## Source-of-content rule

Legacy authority records usually prove digests, not bytes. Migration may read legacy memory/LanceDB
bytes only as untrusted candidate input. A candidate is rebuildable only when all of these hold:

- canonical decoding succeeds within resource/privacy bounds;
- its exact content and semantic digests match a complete signed historical evidence/authority chain;
- exact scope/fact identity, provenance, observation/freshness times, confidence/rank, scope epoch,
  task/objective/plan/execution fences, and source lineage are all signed and current at the migration
  snapshot;
- the old host anti-rollback current head and primary snapshot agree; and
- no signed forget, invalidation, contradiction, tamper, supersession, or later generation fences it.

Matching bytes are re-encrypted into the new authority envelope and admitted only through
`MIGRATE_REBUILD`. LanceDB status/generation/cutoff fields are ignored. Missing or mismatched bytes,
unsigned/reasonless retirement, incomplete history, ambiguous current state, or rollback mismatch
uses `MIGRATE_QUARANTINE`; no trusted cutoff or current content is inferred.

## Durable migration phase machine

Migration owns a signed run ID, source snapshot hashes, source/target schema, deployment, authority
epoch, key IDs, and phase generation.

| Phase                 | Durable result                                                              | Crash/restart action                                           |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `DISCOVERED`          | paths and expected identities only                                          | discard or resume discovery                                    |
| `SNAPSHOT_VERIFIED`   | complete offline source DB/LanceDB/external-ledger/config/key-backup hashes | abort safely before target writes                              |
| `TARGET_PREPARED`     | empty target schema, keyring, authority epoch, readiness disabled           | delete target and abort, or resume                             |
| `CLASSIFIED`          | bounded rebuild/quarantine manifest with source digests and counts          | replay exact classifications only                              |
| `AUTHORITY_IMPORTED`  | all migration events/current rows committed and externally reconciled       | reconcile then resume; no reclassification                     |
| `CHECKPOINT_BUILT`    | signed encrypted projection checkpoint                                      | rebuild projection from checkpoint                             |
| `PROJECTION_VERIFIED` | projection receipt/count/digest equals authority snapshot                   | resume cutover validation                                      |
| `CUTOVER_INTENT`      | external signed target boot/cutover intent                                  | if primary marker absent, signed abort; otherwise roll forward |
| `CUTOVER_COMMITTED`   | target SQLite boot marker plus external current marker                      | roll forward only                                              |
| `COMPLETE`            | readiness may attest this migration run                                     | normal startup                                                 |

The cutover commit uses the same external-intent -> SQLite -> external-current reconciliation as an
ordinary authority transition. Before `CUTOVER_COMMITTED`, abort restores no production path because
the source runtime was never mutated. At and after it, the only automatic action is roll-forward.

The migration source is a verified immutable snapshot. The ordinary legacy memory store remains
untouched so governor OFF continues the exact pre-C07 behavior. Enforce bypasses that legacy path and
uses only the new authority/projection. Disabling C07 later returns to ordinary baseline behavior and
makes no claim that baseline memory includes governed corrections.

## Rollback and downgrade

The complete rollback set is source config, legacy DB/LanceDB, new authority DB/projection,
external journal/head copies, readiness/cutover records, deployment identity, and encrypted key
backup.

- Before cutover, remove the unused target after verifying snapshot hashes; source operation is
  unchanged.
- After cutover but before any post-cutover authority event, an offline operator may restore the
  complete pre-cutover set and append a signed cutover-abort/rollback record under the recovery
  procedure.
- After any post-cutover authority event, binary/schema downgrade is prohibited. The choices are
  roll forward, keep C07 disabled, or restore a complete earlier host snapshot under explicit
  disaster recovery. Partial DB/projection/key restoration is rejected.
- Older binaries cannot open the separately rooted C07 schema and cannot satisfy the readiness
  manifest version. They may run only with C07 OFF against the untouched legacy path.

Migration backup archives are encrypted, ACL-confined, hash-manifested, and retained for a bounded
operator-configured window. Keys are stored separately. Reports contain classifications, digests,
counts, and reasons only, never memory content.

## Required migration tests

- fresh schema and every supported legacy schema produce equivalent target structure;
- valid signed active history rebuilds from digest-matching untrusted bytes;
- unsigned/reasonless active, retired, tombstoned, and ambiguous rows become `LEGACY_UNPROVEN`;
- exact `68a28d` observation-100/expiry-120 state cannot recall or admit observation 110;
- corruption of one byte, digest, scope, provenance, time, lineage, key, head, or projection row
  fails closed;
- crash/restart at every phase follows the table without duplicate events or inferred authority;
- two migration owners serialize; stale owner cannot commit;
- projection rebuild and checkpoint replay converge exactly;
- pre-cutover abort, post-cutover roll-forward, and complete rollback rehearsal preserve boot gates;
- bounded batches/quotas and reports contain no plaintext memory; and
- OFF before/during/after an abandoned migration remains baseline-equivalent.

## Deterministic prerequisite campaigns

These are non-model release prerequisites and are not counted as live-Qwen evidence:

- 100 seeded state-machine sequences covering every transition, forbidden edge, duplicate/conflict,
  epoch, cutoff, lineage, and retention boundary;
- 100 process/crash schedules covering external intent, SQLite commit, external current, outbox,
  projection apply/receipt, checkpoint, migration, restart, and rollback;
- 100 malicious-plugin process trials covering unsolicited frames, replay, cross-invocation response,
  deep import, filesystem/socket/key access, peer identity, symlink escape, oversized payload, and
  shutdown reuse; and
- one long-lived installed LanceDB runtime stress campaign with at least 10,000 mixed
  admit/replace/expire/forget/invalidate/compact/recall operations, exact close/reopen, no native
  crash, no leaked handles, and deterministic final state.

## Exact live-Qwen campaigns

Each campaign uses the frozen reviewed OpenClaw build, production mode, installed service/CLI,
`remote-llm/moira/brain`, and coordinator telemetry attesting
`Qwen/Qwen3.6-27B-FP8` on Narya. A trial is countable only when the source/build/runtime-tree hashes,
model/backend identity, boot ID, test case ID, and sanitized authority/projection counters are
present. Fake providers, direct source runners, simulated lifecycle events, and global test flags are
non-countable.

### C07a: correction and reuse, exactly 100 Qwen calls

- One isolated authenticated scope and canonical operational fact.
- Call 1 presents a stale fact plus one qualified newer correction through the real governed path.
- Calls 2-100 are 99 equivalent queries that require the fact.
- Pass: exactly one authority replacement and one projection remediation; calls 2-100 use the
  replacement/tombstone without source reproof; zero stale recalls, duplicate reinvestigations, or
  extra physical remediation.

### C07b: scope and poisoning isolation, exactly 100 Qwen calls

- 100 isolated trials, one Qwen call per trial.
- Fixed distribution: 20 wrong-scope, 20 weak-authority, 20 equal-authority ambiguity, 20 forged or
  unsigned candidate, and 20 unrelated facts sharing a source event.
- Every trial starts from a verified scope-A/scope-B pair and asks Qwen to use memory in the real
  governed flow.
- Pass: only qualified exact-scope evidence changes A; B and unrelated facts retain exact digests;
  ambiguous/weak/forged candidates do not become current; unrelated allowed tools remain usable;
  zero unauthorized retirements or stale recalls.

### C07c: recovery and convergence, exactly 100 Qwen calls

- 100 isolated trials, one live Qwen recall call after one deterministic pre-call fault schedule.
- Fixed distribution: 10 each for primary-commit crash, external-current crash, outbox claim crash,
  projection apply/receipt crash, gateway restart, compaction, projection rollback, primary rollback,
  expiry, and scope-epoch/source invalidation.
- The deterministic fault action itself is prerequisite harness work; the post-recovery recall is the
  one countable Qwen call.
- Pass: one final authority chain, at most one logical remediation, zero stale recall or duplicate
  reinvestigation; expiry/invalidation creates exactly one justified re-observation; rollback/tamper
  remains quarantined; active/unknown work is never reported complete.

Across the three campaigns the exact count is 300 Qwen calls: 100 C07a + 100 C07b + 100 C07c. Any
missing call, extra retry/model call, wrong model/backend attestation, service restart, gateway OOM,
or incomplete sanitized receipt fails that campaign denominator rather than being discarded.

Sanitized evidence stores opaque run/scope/fact/event IDs, generations, cutoffs, transition/reason
codes, receipt/digest chains, physical operation counts, timings, model/backend/build attestation,
process exits, and resource observations only. It stores no prompts, responses, transcripts, memory
values, credentials, or private source content.
