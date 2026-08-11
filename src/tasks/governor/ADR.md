# Behavior governor control plane

Status: accepted for feature-flagged implementation; production activation is out of scope.

## Context

OpenClaw already has durable `task_runs`, `flow_runs`, and delivery queues. They track execution,
background work, and outbound retries, but they do not own a conversation-level contract, evidence
admission, semantic tool outcomes, deterministic completion, or correction-aware recovery. Prompt
rules cannot provide those guarantees because a model can omit, repeat, or contradict them.

## Decision

Add a behavior-governor control plane under `src/tasks/governor`. It will:

- use the shared private `openclaw-state.db` for an append-only event log, a CAS-fenced task
  projection, scope epochs, effect records, and a transactional outbox;
- link governed tasks to existing task flows instead of replacing `task_runs`, `flow_runs`, or the
  task executor;
- treat model output as proposals and let deterministic code own transitions, evidence admission,
  mutation verification, recovery directives, and delivery eligibility;
- fence every transition and effect with `taskVersion`, `leaseEpoch`, `objectiveRevision`, and
  `executionGeneration` where applicable;
- derive idempotency keys from stable task/event/effect identities, never from retry attempt IDs;
- keep the runtime disabled unless `OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR=1` is explicitly set.

The first production integration seam will be ingress routing into an existing task flow. Until a
separate rollout authorizes that seam, all validation uses synthetic events, fake capabilities, and
isolated SQLite state.

## Invariants

1. A duplicated ingress event creates no second task, mutation, effect, or reply.
2. Authenticated source sequence—not arrival time—orders corrections.
3. A reclaimed lease invalidates stale transitions, tool results, reducers, and outbox sends.
4. Assistant prose or hidden reasoning is never admissible evidence.
5. Transport success alone is never semantic success.
6. Mutations remain incomplete until post-mutation verification is durable.
7. Completion binds the current objective revision, plan version, evidence digests, and
   verification time.
8. Memory retrieval and writes require an exact canonical scope; revocation advances its epoch so
   stale writers cannot resurrect forgotten content.
9. Outbound replies originate only from the transactional outbox.
10. The feature-off path performs no governor database writes and changes no existing behavior.
11. Governor schema is initialized lazily only by an enabled governor store; opening the ordinary
    shared state database does not create governor tables or indexes.
12. Enabled persistence requires `OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY`; channel, account,
    conversation, session, source-message, provenance, and approval-issuer identifiers are
    represented by keyed opaque references in durable governor records.
13. A mutating capability that requires approval accepts only a host-issued opaque grant ID.
    Grant issuance accepts only an authenticated host-integration receipt and signs task scope,
    objective revision, capability/version, canonical target, expiry, key version, and a monotonic
    approval epoch. A model proposal or caller-provided callback cannot mint, extend, or replay a
    revoked grant.
    Host revocation commits its grant tombstone and scope epoch in one durable transaction before
    reporting success; resolver caches are never authoritative.
14. Completion reads durable claims, contradictions, pending-update state, and evidence for the
    current objective and plan only. Corrections cancel old action/fan-out generations and make
    late results audit-only.
15. A controller-owned host registry resolves delivery handles to implementations; dispatch never
    accepts an arbitrary provider object. A host-signed certification binds adapter identity,
    implementation digest, redacted configuration digest, key version, and a monotonic generation.
    Revocation commits its durable generation high-water before reporting success, survives restart,
    and fences replayed older certified rows. Provider receipts are secret-filtered before persistence.
16. The built-in memory adapter truthfully guarantees primary tombstone plus scope-epoch fencing.
    Cache/index/embedding invalidation requires a concrete adapter and must not be reported until
    such an adapter provides verified postconditions.
17. Evidence admission is host-signed over the complete canonical record, including task/scope,
    objective and plan revisions, opaque source identity, timestamp, payload and semantic digests.
    SQLite rejects unsigned, tampered, wrong-key, or legacy admission envelopes. A material response
    claim must exactly match the admitted predicate/value digest. Legacy rows receive impossible
    plan and signature sentinels and therefore cannot satisfy current work until freshly admitted.
18. A response may contain only fixed non-material framing plus deterministic rendering of durable
    material claims bound to the current objective and plan and supported by admitted evidence.
19. Mandatory governor metrics are calculated from append-only deterministic scenario execution
    logs, including duplicate ingress and crash-recovery paths; attempts and observable effects are
    counted separately, and static samples are not evidence.
20. V9 authorization and delivery high-water state is host-owned outside replayable governor
    SQLite tables: an HMAC/hash-chained journal and an independently signed current-head/high-water
    anchor are both required. Missing, lower, mismatched, tampered, truncated, or key-mismatched
    state fails closed; ledger-first writes may be retried to reconcile primary SQLite state.
21. V10 resolves one explicit `GovernorSecrets` context at trusted bootstrap and passes it to the
    broker, anti-rollback persistence, evidence signer, identity codec, and state store. Those lower
    layers never consult ambient process globals. Delivery registration accepts only an allowlisted
    compiled implementation ID, a validated deeply frozen JSON configuration, and a generation;
    callers cannot supply executable code, adapter objects, factories, or registries.

## Consequences

This adds durable state and explicit lifecycle code, but avoids a second execution engine. Existing
task and delivery implementations remain authoritative for performing work; the governor decides
when work is admissible, sufficient, verified, and deliverable. Schema additions are additive and
can remain unused indefinitely while the feature flag is off.

## Rollout prerequisites

The governor remains disabled by default. A future production rollout must first provide host-held
`OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY`, `OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY`,
`OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY`, and
`OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY` as four independently provisioned keys, configure
authenticated evidence, approval, and delivery integration owners, register/certify at least one
compiled host-owned channel implementation, and install concrete
cache/index/embedding invalidation adapters for every governed memory backend. Until then, this is
a synthetic-testable control plane rather than a live message-path replacement.

## Host-authority boundary

The governor treats model, tool, task, plugin, and ordinary controller callers as untrusted. They
may propose a candidate, request approval, reference an opaque grant or delivery handle, and read a
result. They may not mint receipts, sign evidence or grants, advance revocation epochs, register an
adapter, replace a sender, or obtain a secret. This is an object-capability boundary within one
OpenClaw process; it deliberately does **not** claim to protect against a compromised operating
system or process that can read memory or host secrets.

`src/security/governor-host-bootstrap.ts`, `governor-host-broker.ts`,
`governor-host-delivery-implementations.ts`, `governor-host-persistence.ts`,
`governor-host-secrets.ts`, and the anti-rollback ledger form the private host boundary. They are
not in the package export map. A whole-source allowlist permits only the explicit trusted bootstrap
and host-internal dependency edges. Governor, task, model, and plugin code may
consume read-only resolvers from `governor-host-readonly.ts`, but must not import the broker or a
capability constructor. The static boundary test enforces that edge. Test-only synthetic bindings
are rejected unless `NODE_ENV=test`; they are never a production fallback.

V9 ledger sidecars are host-private and store only opaque stream keys, digests, generations, and
signatures. The journal and signed head are separate from replayable governor SQLite tables. A
full host/OS snapshot that replays both sidecars together remains outside Slice 1; hardware or
remote monotonic storage is required for that stronger rollback guarantee.

At a future live rollout, authenticated terminal, UI, and channel integrations must hold separate
narrow evidence, approval/revocation, and delivery capabilities returned only by trusted bootstrap.
The task-facing controller receives read-only resolvers. Bootstrap fails closed without all three
integration owners and at least one certified delivery implementation. The broker retains signing
keys in the runtime secret provider only; SQLite
stores opaque IDs, key IDs/versions, signatures, payload/semantic digests, grants, and monotonic
epoch/generation high-water marks. Rotation creates a new key/version and accepts only explicitly
configured active verification versions. Restart reconstructs state from durable signed records;
revocation high-water marks fence old grants and delivery generations.

Delivery registration resolves a compiled host-owned implementation by allowlisted ID and binds a
deep-cloned, deep-frozen non-secret configuration snapshot. It never accepts or retains a
caller-owned function, closure, object, factory, or registry. A later mutation of the caller's
descriptor or nested configuration cannot change dispatch. Production currently has no certified
channel implementation, so live enablement remains intentionally fail-closed until that concrete
integration is added and reviewed. If no authenticated host integration exists, startup must remain
fail-closed and the feature must remain disabled. `emitTrustedDiagnosticEvent` is explicitly
inadmissible: it is a diagnostic API rather than an authenticated authority boundary and must never
issue a governor receipt, approval, or adapter certification.
