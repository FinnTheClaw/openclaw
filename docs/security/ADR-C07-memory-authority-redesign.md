# ADR: C07 memory authority and projection isolation

Status: proposed; implementation is blocked until a fresh Sol High design review returns GO with
zero P0/P1 findings.

Normative companions:

- `ADR-C07-memory-authority-protocol.md` owns principal, lifecycle, anti-rollback, state-machine,
  confidentiality, checkpoint, and readiness details.
- `ADR-C07-memory-migration-acceptance.md` owns migration, rollback, deterministic prerequisites,
  and exact live-Qwen acceptance.

Supersedes: the C07 same-process trusted-factory and dual-ledger design through
`68a28d83ed2be604a737a66fb0e9eda654da5b12`.

Scope: C07 contradiction-aware operational memory only. This decision does not activate the
behavior governor, change production configuration, or authorize a live campaign.

## Context

The `68a28d` review found four P1 blockers:

1. legacy retired rows have no canonical signed decision and can reopen below the intended cutoff;
2. LanceDB still has unsigned invalidation paths that derive generations and cutoffs;
3. JavaScript module privacy does not protect factories or signing keys from arbitrary same-process
   plugin code; and
4. the shadow inert backend can turn an observational rejection into a persistent runtime failure.

These are not independent leaf defects. They result from two components claiming authority and from
treating a same-process module boundary as a security boundary. The causality ledger in
`governor-memory-c07-causality-matrix.md` preserves the findings and their closing invariants.

## Decision

C07 will have one durable memory control-plane ledger. That ledger alone owns fact identity,
eligibility, generation, provenance, lineage, semantic cutoff, and every transition. A
transactional outbox publishes immutable signed projection events. LanceDB is a disposable
projection/read index: it applies events verbatim and never advances authority.

The authority runs in a trusted gateway supervisor. Arbitrary plugin code does not run in that
process. Plugin execution moves to a separate lower-privilege OS identity and communicates with the
supervisor through a narrow authenticated RPC surface. The Active Memory/LanceDB projection used by
C07 becomes a compiled supervisor subsystem, not a plugin capability. Enforce startup fails closed
unless this process and identity separation is installed and verified.

Module export maps, private TypeScript files, closures, WeakSets, symbols, and caller-supplied
secrets are defense-in-depth only. They are not the trust boundary.

## Goals and non-goals

Goals:

- make one transaction the linearization point for all operational-fact transitions;
- prevent stale recall immediately, independent of vector/index convergence;
- preserve exact scope, fact, provenance, authority, freshness, and source-evidence lineage;
- survive crashes, retries, restart, compaction, projection loss, and primary rollback;
- migrate legacy data without inventing trusted cutoffs or reasons;
- bound every queue, query, tombstone, index, and audit-retention path; and
- preserve behavior when the governor is OFF or in shadow.

Non-goals:

- trusting arbitrary memory text or a model assertion as evidence;
- deleting uncertain facts merely because they conflict;
- using LanceDB, an embedding, a cache, or plugin state as authority;
- supporting enforce mode while untrusted plugins share the supervisor process or OS identity;
- protecting against a fully compromised supervisor identity, kernel, or full-host snapshot rollback;
  and
- claiming deterministic/fake-provider tests as live Qwen acceptance.

## Threat model

### Assets

- current fact eligibility for an exact `(scopeKey, canonicalFactKey)`;
- authority generation and semantic freshness cutoff;
- evidence provenance, confidence/rank, source lineage, and scope epoch;
- the signed transition chain and anti-rollback head;
- projection outbox state and idempotent projection receipts; and
- the memory-authority signing key and database; and
- memory values, canonical text, summaries, embeddings, encrypted payload envelopes, migration
  inputs/backups, and recall associations.

### Adversaries

- model output, prompts, tools, and ordinary memory callers;
- third-party or compromised plugins executing arbitrary code in the plugin host;
- stale gateway/plugin processes and replayed RPC messages;
- corrupted, stale, or malicious LanceDB rows, caches, summaries, embeddings, and indexes;
- process crashes at any transaction, send, apply, or acknowledgement boundary;
- restored older primary or projection databases; and
- legacy rows missing signatures, reasons, cutoffs, lineage, or complete bindings.

### Chosen trust boundary

The trusted supervisor and plugin host run under different OS identities.

- Linux: the service manager creates a supervisor identity and an independently restricted plugin
  identity. Unix-domain sockets, database directories, projection directories, and key files are
  owned so the plugin identity cannot open them. Peer credentials are verified on every plugin RPC.
- macOS: launchd runs the supervisor and plugin host under distinct dedicated accounts with
  equivalent filesystem and local-socket ACL separation.
- The supervisor never passes authority keys, database handles, projection handles, factory
  objects, module paths, or arbitrary callbacks to the plugin host.
- The plugin host has no C07 RPC. The trusted supervisor retains invocation/session context and
  treats a plugin response only as untrusted data for one pending invocation. Recall and admission
  remain trusted-core operations.
- The plugin host cannot open the supervisor authority RPC, control ledger, LanceDB projection, or
  signing-key path.
- Enforce startup proves distinct peer credentials and path confinement before loading C07. If the
  platform cannot establish them, C07 enforce is unavailable.

This boundary prevents same-process impersonation by removing untrusted plugins from the trusted
process. A same-UID helper, bearer token in the gateway process, hidden export, or deep-import ban is
insufficient and is explicitly rejected.

The normative per-principal channel, sequencing, replay, and revocation protocol is in
`ADR-C07-memory-authority-protocol.md`.

### Security properties

1. Exactly one ledger row owns the current state of each exact scoped fact.
2. Every state change allocates its generation and semantic cutoff inside one SQLite write
   transaction before signing.
3. The event, current projection, lineage edges, encrypted payload, and outbox row commit in one
   SQLite transaction. The separate anti-rollback ledger surrounds it with the companion's
   fail-closed external-intent/current reconciliation protocol.
4. Projection events contain the already allocated values; projection code cannot substitute or
   derive them.
5. Unknown, missing, stale, unsigned, legacy, wrong-scope, wrong-lineage, or wrong-generation data
   is ineligible for recall.
6. A projection hit is never returned to a model until the control plane authorizes its exact event
   and current generation.
7. A contradiction affects only the exact fact and its proven descendants. Shared source-event
   identity alone does not authorize unrelated retirement.
8. Equal/weaker or uncertain evidence creates a bounded review candidate; it does not retire current
   truth.
9. Explicit forget is an irreversible scope/fact revocation fence. Expiry permits only a strictly
   newer verified observation. Contradiction, tamper, and supersession require an authenticated
   replacement or explicit quarantined state.
10. OFF loads none of these modules or stores. Shadow writes no control event, projection, receipt,
    failure, or persisted observation and changes no result, continuation, reply, or tool behavior.

## Canonical identities and records

Fact identity is the exact pair `(scopeKey, canonicalFactKey)`. Neither source text, embedding
similarity, plugin ID, nor source event ID can merge identities.

The authoritative current row contains:

- scope and canonical fact keys;
- state and authority epoch;
- current generation and prior event ID;
- current verified memory ID or tombstone ID;
- semantic cutoff and freshness expiry;
- source evidence ID/digest and immutable lineage root/parent IDs;
- provenance kind, source authority identity/key generation, confidence/rank, and observation time;
- scope epoch and task/objective/plan/execution fences where applicable; and
- current event digest and signed anti-rollback head.

An immutable transition event additionally binds:

- event/schema version, event ID, prior/new generation, and prior-event digest;
- typed transition and reason;
- complete prior and target state digests;
- eligibility decision and semantic cutoff;
- exact evidence/provenance/lineage binding;
- server-issued time, deployment/gateway identity, authority key ID/version; and
- signature over the canonical envelope.

No memory value, prompt, transcript, or secret is written to the anti-rollback head. Projection
payloads contain only the minimum content needed by the trusted projection worker and are encrypted
at rest where existing memory storage requires it.

## Closed state machine

States:

- `ABSENT`: no authoritative fact has been admitted.
- `CURRENT`: one verified fact is eligible.
- `REVIEW_REQUIRED`: conflicting evidence is insufficient to choose a replacement.
- `QUARANTINED`: current content is ineligible pending authenticated replacement or operator action.
- `QUARANTINED_UNTRUSTED`: tamper/legacy state has no trusted cutoff and requires an authenticated
  authority-epoch recovery before a new observation can be considered.
- `EXPIRED`: the previous generation is ineligible; a strictly newer verified observation may enter.
- `FORGOTTEN`: irrevocably fenced across every future authority and scope epoch.
- `TOMBSTONED`: replaced or superseded content is retained as bounded audit identity only.
- `LEGACY_UNPROVEN`: migrated data lacks complete proof and is permanently ineligible.

Transitions:

| Transition                | Allowed source                                     | Required authority                                                 | Target and cutoff rule                                                                |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ADMIT`                   | `ABSENT`, `EXPIRED`                                | Current exact-scope admitted evidence                              | `CURRENT`; cutoff is the signed observation/freshness boundary                        |
| `REPLACE`                 | `CURRENT`, `QUARANTINED`, `REVIEW_REQUIRED`        | Qualified newer same-scope contradiction with sufficient authority | prior becomes `TOMBSTONED`; replacement becomes `CURRENT` in one transaction          |
| `EXPIRE`                  | `CURRENT`                                          | Trusted clock plus stored signed expiry                            | `EXPIRED`; cutoff is exactly the stored expiry                                        |
| `FORGET`                  | any non-legacy state                               | Authenticated operator receipt bound to fact/scope/epoch           | `FORGOTTEN`; advances scope/fact revocation high-water                                |
| `CONTRADICT`              | `CURRENT`                                          | Qualified evidence                                                 | `REPLACE` if decisive, otherwise `REVIEW_REQUIRED`; never silent deletion             |
| `TAMPER`                  | any materialized state                             | Failed signature/binding/rollback verification                     | `QUARANTINED`; no reactivation without authenticated replacement                      |
| `SUPERSEDE`               | `CURRENT`                                          | Newer higher-authority verified fact with exact identity           | atomic `REPLACE`; old lineage remains auditable                                       |
| `INVALIDATE_SOURCE`       | any lineage descendant                             | Authenticated source-evidence invalidation                         | transitive descendants become `QUARANTINED` in the same transaction                   |
| `MIGRATE_REBUILD`         | legacy input                                       | Complete verifiable historical authority                           | new authority epoch `CURRENT`; values copied only from proved records                 |
| `MIGRATE_QUARANTINE`      | legacy input                                       | Migration owner                                                    | `LEGACY_UNPROVEN`; no inferred reason, generation, or cutoff                          |
| `ADVANCE_AUTHORITY_EPOCH` | `QUARANTINED_UNTRUSTED` or recovery-required scope | Authenticated host-operator recovery receipt                       | advances the epoch without reactivation; a later new verified observation is required |

Every transition is a compare-and-swap on current event ID, generation, scope epoch, and authority
epoch. A duplicate exact event returns the committed result. Any binding conflict fails closed.

`semanticCutoff` means the minimum exclusive observation boundary for a later admissible fact. The
control-plane transaction computes it once by this closed table:

| Transition                                          | Exact cutoff                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIT`, `MIGRATE_REBUILD`                          | authenticated observation time of the admitted fact                                                                                                       |
| `EXPIRE`                                            | previously signed `freshnessExpiresAt`                                                                                                                    |
| decisive `CONTRADICT`, `REPLACE`, `SUPERSEDE`       | authenticated observation time of the replacement, which must already be strictly newer than the prior cutoff                                             |
| `FORGET`                                            | `max(priorTrustedCutoff, authenticated operator-receipt server time)`, plus a permanent fact-revocation high-water                                        |
| `TAMPER`, `INVALIDATE_SOURCE`, `MIGRATE_QUARANTINE` | prior trusted cutoff if one exists; otherwise no numeric trust is invented and `ADVANCE_AUTHORITY_EPOCH` plus a new authenticated observation is required |

Projection code receives this field and stores it verbatim. It does not inspect timestamps to choose
another value.

The normative monotonic tuple, quarantine recovery, permanent forget, and lineage-cardinality rules
are in `ADR-C07-memory-authority-protocol.md`.

## Elimination inventory for `68a28d` alternate mutation paths

The redesign must delete or close every current path below before enforce can start:

| Existing surface                                                                                     | Problem                                                                  | Required disposition                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryGovernorBackend.invalidate`                                                                   | public unsigned invalidation with caller reason/time                     | remove from the contract; callers submit evidence/proposals to the control-plane transition API                                 |
| `GovernorMemoryLanceDbAdapter.invalidate`                                                            | forwards unsigned replacement/tombstone requests                         | delete; projection adapter exposes only `applyProjectionEvent` and bounded reads                                                |
| `GovernorMemoryLedger.invalidate`                                                                    | derives generation, cutoff, impact, and replacement state inside LanceDB | delete; equivalent behavior is one authoritative transition plus an immutable projection event                                  |
| `GovernorMemoryBackend.retire` and `GovernorMemoryLedger.retire`                                     | a second retirement command surface even when signed                     | delete as commands; expiry/forget are control-plane transitions and projection receives their event                             |
| `retireGovernorFact` calls from admit/invalidate/retire paths                                        | projection helper can be reached from multiple semantic owners           | make private to event application and dispatch only on the event's closed transition type                                       |
| `GovernorMemorySubsystem.quarantine/forget/reconcile` direct status writes followed by backend calls | primary and backend can commit different state/order                     | replace with one control-plane command; callers receive the committed authoritative result                                      |
| lazy recall quarantine/retirement                                                                    | stale data can trigger a new authority mutation while reading            | recall may filter and enqueue a repair request only; it cannot change fact authority                                            |
| `DurableMemoryRuntime.createGovernorMemoryBackend` and caller-selected `authorityBindingKey`         | plugin/runtime code can construct an apparent authority                  | remove from plugin/runtime API; trusted supervisor constructs its internal projection worker from startup secrets               |
| direct SQL writes to authority, projection high-water, remediation, or lineage tables                | bypasses the state machine/outbox                                        | generated durable-boundary inventory permits writes only from named control-ledger transactions or projection event application |

Static AST/import/export/schema inventories and runtime negative tests guard this list. A newly added
mutation verb, direct writer, or key-bearing factory fails architecture checks.

## Transactional outbox and projection protocol

The authoritative transaction writes:

1. the immutable signed transition event;
2. the authoritative current row and lineage changes;
3. one encrypted payload envelope and outbox row keyed by event ID and target projection generation;
   and
4. bounded audit/migration metadata.

The external anti-rollback intent is fsynced before this transaction and its current marker after
the commit. Reads remain unavailable between mismatched phases. Exact crash reconciliation and lock
order are normative in `ADR-C07-memory-authority-protocol.md`.

Outbox states are `PENDING -> CLAIMED -> APPLIED` or `PENDING|CLAIMED -> QUARANTINED`. Claims are
leased and generation-fenced. A crash after apply but before acknowledgement replays the same event
ID. The projection worker must return the same receipt for the same event or a conflict for any
different binding. An unknown outcome never changes authority and blocks only compaction of that
outbox record, not stale-fact fencing.

The signed projection event contains exact target state, prior/new generation, cutoff, lineage,
authority/key IDs, and a projection payload digest. LanceDB may only:

- insert/replace/tombstone the exact projected row named by the event;
- update caches, summaries, embeddings, and secondary indexes to that event generation;
- record an idempotent receipt keyed by event ID; and
- rebuild entirely by replaying retained projection events/current snapshots.

It may not expose `invalidate`, `retire`, `forget`, generation allocation, cutoff calculation, or
caller-selected signing-key APIs. All alternate unsigned mutation paths are removed and guarded by
static import/API inventory tests.

## Recall protocol

1. The trusted recall coordinator resolves the exact authorized scopes.
2. LanceDB returns bounded candidate projection IDs, scores, and event/generation digests.
3. The control plane batch-validates each candidate against authoritative current state.
4. Only exact `CURRENT` candidates with matching event, generation, scope, fact, lineage, and
   unexpired eligibility can be hydrated and returned.
5. A stale, unknown, quarantined, tombstoned, expired, forgotten, legacy, or mismatched candidate is
   filtered immediately and schedules idempotent projection repair.

An optional authorization cache may exist only inside the trusted supervisor, keyed by the signed
authority-head digest. A head change invalidates it. Plugin-host and LanceDB caches are never
authority.

## Shadow and OFF behavior

OFF:

- no C07 dynamic import, authority process, database open, key resolution, plugin isolation change,
  projection open, hook, event, metric, or state directory;
- ordinary memory/plugin behavior is byte-for-byte and control-flow equivalent to the baseline.

Shadow:

- may compute bounded in-memory diagnostics from copies of already-visible data;
- creates no authority state, signed event, outbox item, projection write, receipt, durable metric,
  rejection, exception, continuation, reply, or tool change;
- never constructs an inert backend whose return value is interpreted as a failed admission; and
- exact retries remain ordinary OpenClaw retries.

## Legacy migration and rollback

Migration is offline, restart-required, idempotent, and single-owner. The normative source-of-bytes,
phase, cutover, abort, roll-forward, key/backup, and downgrade rules are in
`ADR-C07-memory-migration-acceptance.md`.

1. Freeze memory writes and create verified backups of the old control DB, LanceDB directory, and
   anti-rollback ledger.
2. Create a migration run with source hashes, source schema, target authority epoch, and a durable
   phase marker.
3. Classify each exact scoped fact:
   - rebuild only when a complete signed source-evidence and host-authority chain proves identity,
     observation/freshness cutoff, generation ordering, provenance, scope epoch, and current
     eligibility;
   - import active facts through `MIGRATE_REBUILD` into a new authority epoch without trusting the
     old LanceDB row;
   - import unsigned, reasonless, incomplete, ambiguous, rollback-mismatched, or legacy retired
     rows through `MIGRATE_QUARANTINE` as `LEGACY_UNPROVEN` with no inferred cutoff or eligibility;
   - never convert an unsigned tombstone into a trusted forget or expiry; and
   - preserve only bounded opaque audit digests for unproven rows.
4. Rebuild LanceDB, summaries, caches, indexes, and embeddings solely from new signed projection
   events.
5. Verify row counts, identity counts, signatures, authority heads, outbox convergence, and absence
   of eligible legacy rows before enabling reads.
6. Commit cutover through the external-intent -> target-SQLite -> external-current protocol. The
   ordinary legacy store remains untouched for OFF; enforce uses only the new authority.

A quarantined legacy identity may become current only through a new post-cutover authenticated
observation and an explicit replacement transition. Migration does not invent a freshness cutoff.

Rollback after cutover cannot run the old binary against the new store. The operator must either:

- restore the complete pre-cutover snapshot before any new-authority event was accepted; or
- remain on the new schema and disable C07.

The new authority epoch and signed migration high-water reject partial primary/LanceDB rollback.
Projection rollback triggers replay/rebuild; it never changes eligibility.

## Retention and capacity

- Current rows are one per exact scoped fact.
- Transition events and projection receipts use bounded hot retention plus signed encrypted
  projection checkpoints containing complete rebuild envelopes and permanent fences.
- Named forget and tamper fences survive event compaction in scalar high-water rows.
- Candidate/review rows have per-scope and global quotas, TTLs, pagination, and deterministic oldest
  eligible archival.
- Outbox claims, retries, unknowns, and dead letters are bounded and indexed by state/lease/event.
- Lineage traversal has explicit depth/node limits and a cycle-rejecting insert transaction.
- Recall requires a caller limit and applies a stricter server maximum before vector search.
- Reaping is bounded-batch and cannot remove the only replay/forget/authority high-water.

## Implementation slices after design GO

No slice starts before all three C07 design records receive design GO.

1. **Activation interlock and trust boundary:** first remove/block every C07 activation entry, then
   add the signed readiness/version gate, supervisor/plugin-host process contract, distinct-identity
   bootstrap, principal protocol, path ACL checks, and OFF gating. No memory behavior change and no
   intermediate commit can enable C07.
2. **Control ledger:** add bounded contract/state-machine modules, schema, signatures,
   anti-rollback binding, lineage CAS, and transactional outbox.
3. **Projection worker:** move C07 LanceDB ownership into trusted core; replace mutation APIs with one
   idempotent `applyProjectionEvent`; remove every alternate invalidation path.
4. **Recall gate:** add authoritative batch eligibility and repair scheduling before hydration.
5. **Migration:** implement classification, quarantine/rebuild, projection rebuild, cutover, rollback
   fence, and doctor/reporting commands.
6. **Shadow/OFF:** prove zero-load/zero-write/zero-observable-delta behavior.
7. **Acceptance:** complete deterministic crash/security/lifetime tests, freeze/build review, then the
   separately authorized live-Qwen campaign.

Each new responsibility and test file must remain below 500 non-comment/nonblank lines. Oversized
existing integration files receive adapter-only deletions or calls into bounded leaves.

## Deterministic test plan

### State-machine and authority tests

- table-test every state/transition/reason pair, including forbidden edges;
- duplicate and conflicting event replay; wrong scope/fact/generation/epoch/key/signature;
- equal/weaker/uncertain contradictions versus decisive newer evidence;
- transitive lineage invalidation, cycles, cross-scope/cross-task mismatch, and independent facts
  sharing one source event;
- expiry re-observation positive control and explicit-forget rollback/restart non-reactivation;
- tamper quarantine and authenticated replacement; and
- monotonic cutoff/generation allocation in the same transaction.

### Crash, restart, and concurrency tests

Fault every boundary:

- before/after event insert, current-row CAS, lineage update, outbox insert, commit, anti-rollback
  marker, claim, projection apply, receipt, and compaction;
- two processes racing admit/replace/forget/expire/invalidate;
- authority restart with pending/claimed/applied outbox;
- projection loss, partial index update, duplicate apply, corrupt receipt, and rebuild;
- primary rollback, projection rollback, anti-rollback truncation, key rotation, and stale process;
- one long-lived installed LanceDB runtime performing repeated write/replace/invalidate/compact/recall
  operations, then close/reopen, with no native crash or leaked handles.

Every test asserts one authority generation, exact cutoff equality, bounded rows, no stale recall, and
deterministic final authority/projection state.

### Migration and security tests

- fresh schema versus every supported legacy schema;
- signed active history rebuild; unsigned/reasonless retired, tombstone, and active rows quarantine;
- legacy `68a28d` rows specifically cannot admit observation 110 after expiry 120;
- concurrent migration owner, crash at each phase, restart, exact replay, and rollback procedure;
- malicious plugin attempts deep imports, filesystem/database/socket/key access, forged RPC identity,
  replay, wrong peer credentials, symlink escape, and oversized payloads;
- prove the plugin OS identity cannot open authority/LanceDB/key paths or authority socket;
- public SDK/manifest inventory proves no authority mutation API or key-bearing factory;
- OFF module-load/state-tree differential and shadow success/failure/cancel/retry differential; and
- retained plugin/RPC handles fail after shutdown without reopening stores.

### Projection and recall tests

- every cache, summary, vector, embedding, and exact-key path is stale-fenced by authority;
- stale projection before convergence never reaches a caller;
- equivalent queries reuse the verified replacement/tombstone and completed remediation receipt;
- scope A correction never changes scope B;
- candidate, weak, equal, forged, expired, rolled-back, and poisoned records remain ineligible;
- projection repair is idempotent and bounded; and
- compaction preserves replay, forget, lineage, and authority high-water.

## Exact 100x live-Qwen acceptance mapping

The normative campaigns and denominators are in
`ADR-C07-memory-migration-acceptance.md`: C07a, C07b, and C07c each contain exactly 100 countable
production-mode Qwen calls, for 300 total. Deterministic fault actions are prerequisite evidence and
are not misreported as model calls. Live work remains blocked until implementation, deterministic
tests, immutable review, freeze, and separate authorization are complete.

## Release gates

- design review: one fresh Sol High exact-object review, zero P0/P1;
- implementation reviews: exact immutable SHAs and explicit P0/P1 verdicts per slice;
- schema/generated types, database-first, manifest, boundary, cycle, LOC, privacy, format, lint, and
  relevant typegraphs green on a safe host;
- production-mode process-boundary and long-lived real-LanceDB tests green;
- migration dry run and rollback rehearsal on sanitized fixtures;
- governor remains OFF through source review, freeze, and deployment authorization; and
- live acceptance cannot start until the exact reviewed SHA is frozen and independently authorized.

## Rejected alternatives

- **Private JavaScript module or export map:** same-process arbitrary code can deep import, monkey
  patch, inspect memory, or call exposed constructors.
- **Bearer key/capability in the gateway process:** same-process plugins can impersonate the holder.
- **Two authoritative ledgers:** inevitably permits generation/cutoff/eligibility divergence.
- **LanceDB-side invalidation:** makes a read index an authority and creates crash-order ambiguity.
- **Migration inference:** a timestamp or status without signed provenance cannot establish a trusted
  cutoff or reason.
- **Test-process isolation as a native-lifetime fix:** release requires stable repeated operations in
  one long-lived installed runtime plus close/reopen.

## Consequences

The redesign is larger than a leaf correction and requires packaging/provisioner work for distinct
service identities. It removes the existing same-process C07 activation path rather than hardening
it incrementally. In return, authority is explicit, projection is replaceable, stale recall is
fenced immediately, migration is honest, and plugin compromise cannot mint memory truth merely by
sharing the gateway process.
