# C07 normative authority protocol

Status: proposed companion to `ADR-C07-memory-authority-redesign.md`. Both documents require design
GO before implementation.

This document closes the process, principal, lifecycle, reconciliation, projection, state-machine,
confidentiality, and activation details that are normative for C07.

## Principal and RPC model

The trusted supervisor is the only C07 client and server. Untrusted plugins receive no C07 socket,
method, credential, capability, recall result, or authority handle.

- The supervisor starts one isolated process per plugin package under the restricted plugin OS
  identity. A process may handle multiple invocations for that package, but it has no supervisor
  authority endpoint.
- The supervisor initiates each plugin invocation and retains the authoritative invocation context:
  boot epoch, plugin package digest, agent/session/scope, tool/capability, request sequence, and
  expiry. The plugin receives an opaque request ID and bounded input only.
- A plugin response is untrusted data associated with that one pending request. It cannot supply or
  override agent, session, scope, authority, generation, provenance, evidence, or eligibility.
- Unsolicited, duplicate, expired, wrong-sequence, wrong-boot, or nonpending response frames are
  rejected. Closing/revoking the pending invocation invalidates every later response.
- Memory admission happens only after trusted core evidence admission binds the plugin response or
  tool result to the retained invocation context. A plugin response alone is never authority.
- Recall is a trusted core operation. The supervisor authorizes scope from the current agent/session
  route, queries and filters memory, and sends the result only to the authorized model/runtime. It
  does not expose a general recall RPC to plugins.
- Each child plugin process receives a one-way supervisor-created channel after spawn. Peer
  credentials, child PID/start time, executable/package digest, boot epoch, and a monotonic frame
  sequence are bound at the supervisor. The child cannot create another principal or reuse the
  channel after restart.

This removes the confused-deputy path: arbitrary plugin code can influence only untrusted proposal
content for its current invocation. It cannot choose the authority principal or ask the supervisor
to act for another session.

## Provisioning and key lifecycle

Provisioning is root/administrator-owned and restart-only.

1. Create distinct supervisor and plugin service accounts.
2. Create the supervisor state, authority DB, projection, socket, and key directories with
   confinement checks and ACLs denying the plugin identity.
3. Generate or import the memory event-signing key and content key-encryption key through canonical
   SecretRefs. Plaintext configuration is invalid.
4. Create a deployment identity and authority epoch. Bind both to the external anti-rollback head.
5. Record only key IDs/versions and deployment digests in SQLite. Raw keys stay in the supervisor
   secret snapshot and are never copied to plugin state, arguments, environment, logs, or RPC.

The active verification keyring contains one signing key and a bounded configured set of prior
verification keys. Rotation:

- requires an authenticated operator receipt and a gateway restart;
- appends a signed rotation intent under the old key, activates the new key/version, and appends a
  current marker cross-binding old and new key IDs;
- never rewrites semantic generations or cutoffs;
- permits prior-key verification only until a signed retirement high-water and retention deadline;
  and
- rejects an event signed by a retired, unknown, or future key.

Key loss or a keyring/head mismatch enters `RECOVERY_REQUIRED`. No C07 read, write, migration,
projection apply, or compaction is available. Recovery requires an authenticated operator procedure
and a complete verifiable backup; it never initializes a new trust root beside nonempty state.

## Process lifecycle

Lifecycle states are:

`CLOSED -> PREPARING -> RECONCILING -> READY -> DRAINING -> CLOSED`, with any uncertain state
entering `RECOVERY_REQUIRED`.

Startup order:

1. acquire the singleton supervisor lock and bind deployment/boot epoch;
2. resolve the immutable secret snapshot;
3. verify account separation, path ownership, confinement, socket parent, and key ACLs;
4. verify both external anti-rollback copies and the active keyring;
5. open the authority DB, reconcile external intent/current markers, and verify schema/readiness;
6. reconcile migration and projection checkpoints/outbox;
7. open the trusted projection worker and verify its epoch;
8. publish the runtime readiness attestation; and
9. only then start restricted plugin processes and admit governed work.

A stale socket is removed only while holding the singleton lock and after proving no matching live
supervisor boot epoch. A plugin process restart creates a new child identity/channel and cannot
resume old frames. Authority or projection unavailability makes governed memory unavailable; it
does not fall back to an unsigned backend. Bounded admission and outbox queues apply backpressure
before accepting optional work. Security transitions have reserved capacity; exhausting it moves
C07 to fail-closed draining.

Shutdown first fences new governed memory operations, then cancels/drains pending trusted
invocations, persists resolvable outbox state, closes plugin channels/processes, closes projection,
closes SQLite, releases secrets, and finally releases the singleton lock. Every stage is attempted;
errors aggregate and prohibit in-process restart over uncertain state.

## External anti-rollback reconciliation

The external anti-rollback journal/head and SQLite cannot commit atomically. The protocol is a
fail-closed three-phase reconciliation under the external journal's OS-backed cross-process lock:

1. **Intent:** append and fsync a signed external intent binding the prior external head, prior
   SQLite snapshot digest, target operation/event digest, target SQLite snapshot digest, deployment,
   authority epoch, and operation ID.
2. **Primary:** while still holding the external lock, run one `BEGIN IMMEDIATE` SQLite transaction.
   Verify the prior snapshot/event/generation, then atomically commit the immutable event, current
   row, lineage changes, encrypted payload, outbox row, and operation ID/target digest.
3. **Current:** append and fsync the signed external current marker for the committed target, update
   the independently signed full-state head, and release the locks.

Reads and writes are unavailable whenever the external current marker and SQLite current snapshot
do not match. Recovery is deterministic:

| External/SQLite state                                                   | Recovery                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| no intent; current equals SQLite                                        | available                                                                    |
| intent target; SQLite still equals authenticated prior                  | append signed abort to prior; available                                      |
| intent target; SQLite equals authenticated target                       | append/finalize current marker; available                                    |
| current target; SQLite target                                           | available                                                                    |
| current target; SQLite prior/other                                      | rollback detected; `RECOVERY_REQUIRED`                                       |
| intent/current or SQLite matches neither authenticated prior nor target | `RECOVERY_REQUIRED`                                                          |
| either external copy missing/corrupt                                    | repair only from the other verified copy; both bad means `RECOVERY_REQUIRED` |

Recovery never guesses from timestamps. Lock order is external journal lock, then SQLite write lock;
no path may acquire them in reverse order. Projection claims do not hold the external lock because
they cannot change authority.

## Closed authority state machine clarifications

Cutoff ordering is the tuple `(authorityEpoch, semanticCutoff)`. Within an epoch, cutoff is
monotonic. A transition stores `max(priorCutoff, authenticatedTransitionCutoff)` when prior cutoff is
trusted.

- `FORGET` stores `max(priorCutoff, operatorReceiptServerTime)` and a permanent fact-revocation
  high-water. It survives every later authority/scope epoch. There is no unforget transition.
- `EXPIRE` stores exactly `max(priorCutoff, signedFreshnessExpiresAt)` and permits only a strictly
  newer verified observation.
- `QUARANTINED_TRUSTED` may accept an authenticated decisive replacement in the same authority
  epoch.
- Tamper/legacy state without a trusted cutoff enters `QUARANTINED_UNTRUSTED`. It cannot use ordinary
  `REPLACE`.
- `ADVANCE_AUTHORITY_EPOCH` is a host-supervisor operation requiring an authenticated operator
  recovery receipt bound to deployment, scope/fact set, prior head, reason, and target epoch. It
  never reactivates a fact; it only permits a subsequent newly authenticated observation to create a
  new current row. Permanent forget high-water still wins.
- `ADVANCE_SCOPE_EPOCH` is an authenticated scope-revocation transaction. The per-scope fact quota
  makes its complete set bounded: trusted states become `QUARANTINED_TRUSTED`, untrusted/legacy
  states become `QUARANTINED_UNTRUSTED`, absent identities remain absent, and permanent forget wins.

Lineage insertion enforces per-root descendant count, maximum depth, maximum direct children, and
per-transaction node limits before admission. The bounds are immutable policy in the readiness
manifest. Therefore `INVALIDATE_SOURCE` can lock and quarantine the complete transitive descendant
set in one bounded transaction; exceeding the bound rejects the earlier lineage admission, never a
later invalidation.

## Encrypted payload and confidentiality contract

Memory values, canonical text, summaries, embeddings, projection payloads, and query/result
associations are sensitive assets. Durable plaintext is forbidden in the authority DB, outbox,
checkpoints, dead letters, migration journal, diagnostics, and logs.

Each fact payload uses a random per-fact data-encryption key (DEK). A supervisor-only key registry
stores its KEK-wrapped value exactly once. Checkpoints, outbox records, projection rows, dead letters,
and backups contain only the opaque DEK reference, never another wrapped-key copy. The canonical AEAD
envelope contains:

- algorithm/version, ciphertext, nonce, authentication tag, DEK reference and KEK ID/version;
- scope/fact, event ID, generation, authority/projection epoch, content and semantic digests;
- payload type/schema and canonical associated-data digest; and
- optional source-byte digest needed for verified migration.

The event signature binds the complete envelope metadata, ciphertext digest, and associated-data
digest. Audit retains only irreversible digests/high-water after erasure.

The trusted projection worker decrypts only in memory. LanceDB stores the minimum encrypted payload
and plaintext vectors needed for search; vectors and metadata are treated as sensitive derived data,
kept in the supervisor-only directory, and included only in encrypted backups. Hydration occurs in
the supervisor after authoritative eligibility. Logs and dead letters contain event IDs, bounded
codes, digests, and counts only.

### Durable erasure state machine

Forget first commits the absorbing authority fence. Physical/cryptographic cleanup then follows this
restart-safe FSM:

`ERASE_PENDING -> REFERENCES_VERIFIED -> PROJECTION_DELETED -> CHECKPOINT_REPLACED -> BACKUP_FENCED
-> KEY_TOMBSTONED -> KEY_DESTROYED -> ERASE_COMPLETE`.

- `REFERENCES_VERIFIED` enumerates the exact DEK reference across authority rows, outbox, dead
  letters, checkpoint catalog, projection receipts, and the managed backup catalog. A new reference
  cannot be created after the authority fence.
- `PROJECTION_DELETED` requires the event-bound deletion receipt and verifies no current
  projection/index/cache/summary row uses the reference.
- `CHECKPOINT_REPLACED` publishes and applies a post-forget checkpoint that contains only the
  permanent forget high-water, then makes every older checkpoint ineligible for restore.
- `BACKUP_FENCED` appends the DEK reference to the external signed erase high-water. Every managed
  restore consults the current external high-water before restoring key-registry entries. Catalogued
  backups are reindexed or destroyed under retention; none may restore a fenced key.
- `KEY_TOMBSTONED` verifies a zero live-reference count and persists the irreversible key-registry
  tombstone. `KEY_DESTROYED` removes the sole wrapped DEK. Duplicate cleanup is idempotent.
- A crash resumes from the durable phase. Recall is already denied from `ERASE_PENDING`; an unknown
  projection/backup result blocks erasure completion and key deletion rather than weakening the
  authority fence.

Unmanaged copies and complete hostile host snapshots remain outside the software boundary and are
not claimed as cryptographically erased.

### KEK rotation state machine

KEK rotation is
`ROTATION_PREPARED -> REWRAPPING -> REFERENCES_VERIFIED -> SWITCHED -> OLD_KEY_RETIRED -> COMPLETE`.

- Preparation records old/new KEK IDs, the exact active DEK-reference snapshot, rotation generation,
  and external signed intent.
- Rewrapping runs bounded idempotent batches. Each key-registry row CASes old wrapper/version to the
  new wrapper/version and records the rotation generation. Forgotten/tombstoned DEKs are never
  recreated.
- Verification scans authority, outbox, checkpoint, projection, dead-letter, key-registry, and
  managed-backup catalogs and proves every live reference resolves through the new KEK or an
  explicitly retained prior verification key.
- `SWITCHED` makes the new KEK current under the external-intent/SQLite/current protocol. New writes
  cannot use the old KEK.
- The old KEK is destroyed only after zero live references and every managed backup has been
  rewrapped, expired, or fenced. Crash/restart resumes the recorded phase; conflict or missing key
  enters `RECOVERY_REQUIRED`.

## Projection checkpoints and bounded outbox

A signed projection checkpoint contains:

- checkpoint/projection epoch and schema;
- authority-head digest and replay base/final event sequences;
- one canonical encrypted envelope for every current eligible row;
- permanent forget/tamper/legacy fences and required lineage/tombstone high-water;
- projection configuration/embedding model digest; and
- checkpoint payload digest, key IDs, signature, creation state, and projection receipt.

Checkpoint creation reads one SQLite snapshot, builds the encrypted checkpoint, then publishes its
digest/base under the anti-rollback reconciliation protocol. Events are compactable only after the
checkpoint is current, applied by the projection, independently verified against authoritative
rows, and followed by no unresolved event at or below its final sequence.

Projection rebuild starts empty at a fresh projection epoch, applies the latest verified checkpoint,
then replays later events in sequence. It cannot serve recall until caught up and verified.
Unknown/dead-letter events pin their sequence and block checkpoint compaction. Hot events, unknowns,
and checkpoints each have fixed quotas and state-leading indexes. When ordinary capacity is full,
new admissions/replacements are rejected before authority commit. Reserved security capacity permits
forget/expiry/tamper/source invalidation; exhausting it drains C07 fail closed rather than dropping an
event or growing without bound.

## Readiness and partial-implementation interlock

The first implementation slice removes/blocks every C07 activation entry and installs an
unconditional architecture-version gate. No intermediate slice can enable enforce.

The final runtime accepts enforce only when a signed, generated readiness manifest and runtime
attestation agree on:

- minimum C07 architecture/schema/protocol versions;
- compiled transition-table and alternate-writer inventory hashes;
- process/OS-identity and path/socket ACL attestation;
- authority/keyring/deployment/boot and external-ledger status;
- control-ledger, projection-event, recall-gate, checkpoint, and migration versions;
- current migration cutover marker and projection epoch; and
- required deterministic test/build manifest digest.

The manifest cannot be supplied by config or plugin code. Missing, partial, stale, future, mismatched,
or unsigned readiness returns `C07_ARCHITECTURE_NOT_READY` before loading memory authority secrets or
opening state. OFF bypasses the C07 gate and retains legacy behavior. Shadow never qualifies as
enforce readiness and remains ephemeral.
