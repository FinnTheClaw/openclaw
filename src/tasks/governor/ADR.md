# Behavior governor control plane

Status: accepted for feature-flagged implementation; production activation is out of scope.

## Context

OpenClaw already has durable `task_runs`, `flow_runs`, and delivery queues. They track execution,
background work, and outbound retries, but they do not own a conversation-level contract, evidence
admission, semantic tool outcomes, deterministic completion, or correction-aware recovery. Prompt
rules cannot provide those guarantees because a model can omit, repeat, or contradict them.

## Decision

Add a behavior-governor control plane under `src/tasks/governor`. It will:

- reuse the shared private SQLite implementation and schema boundary for an append-only event log,
  a CAS-fenced task projection, scope epochs, effect records, and a transactional outbox, while
  the production gateway roots the governor database separately below `<stateRoot>/governor`;
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
22. V11 permits one active verified memory per canonical fact and exact scope. Only admitted,
    trusted, newer same-fact evidence may atomically supersede it; the old revision remains
    auditable, while normal retrieval returns the verified replacement. Equal-authority ambiguity
    creates one unresolved review without choosing a winner. Canonical-source remediation is
    deduplicated by the stale canonical memory source, fact, scope, and contradiction class, not by
    whichever observer supplied the correcting evidence. It uses the existing governed action path
    and closes only after fresh exact-source verification. Repeated reads reuse the resolution; only
    material new evidence, replacement expiry, a different scope, or an explicit operator request
    qualifies for reinvestigation.
23. V12 resolves delivery only through three compiled host implementations: the fixed disposable
    canary sink and Signal/iMessage through OpenClaw's compiled core outbound service. Strict
    configuration binds adapter generation, deployment, channel, account, normalized target,
    implementation, and payload digests. Shadow mode performs all checks but no send or canary
    append. A missing stable
    provider receipt is an unknown outcome: the outbox never retries blindly and records one durable
    manual-review state unless authoritative reconciliation proves the original send. Owner actions
    enter only through a private compiled ingress capability whose authenticated envelope exactly
    matches a host-configured channel, account, gateway, principal, action, and scope. Durable
    receipts contain keyed opaque identities and are single-use.
24. V14 revalidates a delivery's durable implementation, generation, revocation, deployment,
    delivery key, and payload at a transactional effect-start boundary immediately before the
    compiled sender is invoked. Revocation that wins that boundary produces no external effect;
    revocation cannot claim success after an effect has started until its authoritative outcome is
    completed or reconciled.
25. Authenticated owner ingress uses a durable leased claim followed by idempotent task ingestion
    and a bound finalization. Receipt, deployment, source binding, action/scope, claimant attempt,
    and task identity remain opaque. Concurrent processes can claim once; a crash after ingestion
    replays the same task event, while a consumed or revoked receipt remains closed after restart
    and primary-database replay. The broker-derived source identity is folded into the task scope;
    callers cannot supply a separate high-water key. A per-source sequence high-water has no task
    deletion cascade, survives terminal cleanup, and does not merge independently authenticated
    sources.
26. Approval admission revalidates the signed receipt against the host anti-rollback ledger while
    holding the task database write lock. This orders admission against revocation, including the
    ledger-first crash window, so a revoked grant cannot arrive later through task-side admission.
27. Delivery certification uses a generated deterministic source manifest. Its TypeScript parser
    follows the full static and literal-dynamic relative-import closure from the governor delivery
    entry points, includes every runtime file under the Signal and iMessage plugin roots, and binds
    package.json plus the pinned dependency lockfile. The architecture check verifies that generated
    manifest before certification; a covered source or dependency-lock change requires a new digest
    and certification generation. This detects mismatch inside that source/build trust root. It does
    not attest installed package bytes, post-build binary tampering, a fully compromised process or
    filesystem, or full-host snapshot rollback.
28. A privileged action binds a digest of the immutable configured capability policy at admission.
    Persistence and the SQLite execution-claim transaction independently recompute that policy and
    reject caller-stated approval flags, legacy unverifiable policy rows, or configuration drift.
    A worker claim alone never authorizes an external mutation. A separate transactional effect-start
    fence revalidates the unexpired lease, current task/execution identity, capability policy, grant,
    and revocation epoch immediately before work begins. Revocation that wins first cancels even an
    unexpired bare claim; an effect-start that wins first remains explicitly in flight until a
    host-authenticated termination outcome is durable. Expired and late results are audit-only.
29. Public memory writes create untrusted candidates only. Verified memory fields are derived from
    current-plan, exact-scope, admitted evidence; caller-supplied status, source, confidence, and
    provenance fields are rejected. Current objective, plan, scope, and evidence signatures are
    revalidated while holding the same SQLite write transaction that promotes, supersedes, or
    verifies memory. Recall re-verifies all persisted content/semantic bindings. Legacy verified
    rows without complete admitted-evidence bindings are retained as quarantined audit history and
    excluded from normal recall, so migration neither trusts them nor wedges the scope.
30. A certified Signal or iMessage handle captures the exact compiled outbound function and frozen
    configuration during trusted bootstrap. Dispatch never re-resolves the mutable plugin registry.
    The build-owned manifest covers the governor delivery implementation, plugin SDK closure,
    Signal/iMessage runtime roots and package metadata, and the pinned dependency lockfile.
31. An `effect_started` delivery may reconstruct only the same byte-identical certified adapter for
    authoritative reconciliation or one durable host-owned manual-review outcome (`confirmed_sent`,
    `confirmed_not_sent`, or `retired_unknown`). Reconstruction never resets the effect or permits a
    blind resend. A terminal review permits safe adapter revocation/rotation, while unrelated
    certified deliveries remain available throughout.
32. Host journal serialization uses SQLite's OS-backed cross-process write lock rather than a PID
    lock file. The coordination database carries no authority and may be recreated; process death
    releases the lock, while the signed journal and head remain the anti-rollback truth. This still
    does not protect against replaying a full host snapshot without hardware monotonic storage.
33. Fan-out has unlimited logical queue depth but exactly three host-owned physical execution slots.
    Lease expiry requests cancellation without freeing a slot. Only a durable completed result or an
    authenticated supervisor termination/crash receipt releases physical capacity; late results are
    rejected. Host-ledger slots survive primary-database replay, and orphan recovery is explicit and
    audited rather than inferred from elapsed time.
34. Approval revocation is reconciled from the host ledger into action state before claim,
    effect-start, pending-work, outcome, or completion decisions. A ledger-first crash therefore
    cancels an unstarted action on retry/restart instead of leaving it permanently pending. An
    effect that already crossed its host fence remains explicitly unresolved until authenticated
    termination evidence arrives.
35. Verified memory supersession has its own host-ledger generation and binding digest. Restoring
    older governor SQLite state cannot reactivate a disproven fact: a mismatched row is quarantined
    or tombstoned and one deduplicated re-observation requirement is recorded. The signed host
    high-water also records monotonic observation/recording time, source rank, confidence, scope
    epoch, and task/objective/plan fence. Older, weaker, retired, or prior-plan bindings cannot
    advance it, satisfy re-observation, or retire a newer current binding. The ledger contains only
    opaque fact keys and digests, not memory values. An unadmitted broker receipt is ephemeral and
    requires re-observation after restart. Once admission commits, durable signed evidence may
    survive ordinary restart only while its task, objective, plan, scope, freshness, and fence
    remain current; primary-state rollback requires fresh observation unless the protected current
    row can still be verified. Full host-snapshot rollback remains outside this software-only
    boundary.
36. Every public persistence ingress and each lower durable binder is bounded before serialization
    or recursive inspection.
    Governor JSON rejects excessive bytes, strings, depth, nodes, properties, arrays, and
    collections, as well as cycles, accessors, unsupported prototypes/types, invalid Unicode,
    non-finite numbers, and prototype-pollution keys. Credential field names are classified after
    case/separator canonicalization; findings expose only hashed field tokens. Durable task scope is
    revalidated against the stored host-derived opaque scope inside the write transaction, and
    caller flow identities are persisted only as stable keyed opaque references. A static inventory
    test covers transactional writers and JSON codecs so a newly added path cannot silently omit
    the guard.
37. Ordinary governed OpenClaw child runs use the existing durable fan-out, three-slot physical
    authority, and reducer. Registration, terminal result, and termination require exact
    host-issued lifecycle receipts; caller-reported status is inadmissible. Parent completion stays
    blocked while a child is queued, physically unresolved, unknown, or completed but unaggregated.
    Durable child identity derives from the parent/task fence plus canonical external-child
    identity, not receipt identity; multiple authenticated retry receipts therefore converge on one
    job and fan-in result while distinct children remain distinct. The child integration owner can
    issue only child lifecycle observations, and feature-off creates no child state or capability.
38. V24 makes the signed host ledger authoritative for each task's opaque scope, authenticated
    source sequence, task/objective/plan revisions, lease epoch, execution generation, state, and
    canonical projection digest. A transition first appends a signed intent, then commits SQLite,
    then appends a signed current marker. Exact retry or restart reconciles either interrupted edge;
    a conflicting or older primary snapshot remains unavailable rather than authorizing stale
    memory, evidence, fan-out, effects, completion, or delivery. Complete loss of both independently
    signed ledger copies beside nonempty governor state enters explicit recovery-required state;
    only a provably empty governor store may initialize a new authority. Canonical codecs recompute
    and bind task, event, effect, fan-in, reducer, and outbox JSON/digests to their scalar columns.
    Security-owned AST inventory tests require every durable reader/writer to declare its codec,
    resource/privacy guard, and host-fence enforcement. Untrusted boundary failures expose stable
    bounded codes rather than caller identifiers, key paths, payloads, or parser causes.
39. V26 task intents authenticate both the prior and target fence plus a timestamp-independent
    semantic operation digest. Ordinary reads may finalize only an already-applied target. Startup
    recovery or a failed writer may abort an unapplied intent to its authenticated predecessor only
    while holding the SQLite write lock; any third state remains unavailable. Work mode is rederived
    from the canonical contract and the host capability-policy
    digest, so caller hints can increase conservatism but cannot classify mutation, approval,
    external-evidence, continuation, child/fan-out, or governed-memory work as `QUICK`. Repair-state
    transitions require the current task/objective/plan/execution fence and a status/timestamp CAS.
    Enabled bootstrap validates the versioned policy-semantics bundle, while raw governor
    schema/migration/coordination SQL is explicitly owned in the durable-boundary registry with
    idempotency and recovery rules.
40. V33 adds an opt-in bridge at the production embedded `Agent` loop. OFF installs no scope or
    hook and leaves the legacy loop unchanged; shadow records decisions without blocking legacy
    execution. The first enforceable integration is intentionally a closed, compiled, disposable
    read-only tool set. Bootstrap binds each tool name to an allowlisted implementation ID and the
    exact frozen tool object installed for that run; a same-name plugin or mutable registry entry
    cannot inherit its capability, target, or evidence authority. The bridge admits only the
    effective result after existing post-tool hooks and binds observations to the exact effect,
    implementation digest, capability/version, target, and result digest. Host-assigned ingress
    sequencing is monotonic and durable for channels with nonnumeric message IDs. Interrupted
    read-only effects become durable non-evidence outcomes and force replan; expired read-only
    claims can resume idempotently after restart. Adapter-only bootstrap rejects an agent-loop
    configuration because it cannot own the required process-global teardown. Bootstrap rejects
    every mutating or approval-requiring binding and any `sessions_spawn` external-child binding;
    V33 does not claim support for either capability until separate host-owned postcondition
    verification and pre-dispatch child admission/terminal integration exist. This slice therefore
    authorizes only a read-only disposable live-model canary, not production rollout.

41. The gateway integration is lifecycle-owned and restart-only. An absent or disabled
    `experimental.behaviorGovernor` value does not load heavyweight host/bootstrap/state modules,
    resolve governor secrets, open governor state, or install the process-global host; a tiny
    inert runner registry remains statically available. An explicitly enabled
    configuration is accepted only from the typed config surface, canonical `SecretRef` values,
    the active startup secret snapshot (resolved through the canonical startup authority), its
    opaque generation, and a closed host-owned binding factory. Resolved values cross this trusted
    lifecycle boundary only; task, model, plugin, and ordinary tool code never receives them.
    The factory may return a private rollback handle only when it owns an allocation; otherwise it
    is a pure compiled-registry lookup. A governor config change while active returns
    `GOVERNOR_GATEWAY_RESTART_REQUIRED` and leaves the old generation installed. A secret-provider
    refresh is restart-only in this slice: the gateway must be restarted before a rotated governor
    key is applied because no hot-refresh callback is claimed here.
    Shutdown drains that generation's scopes before revoking authorities and closing its dedicated
    `<stateRoot>/governor` persistence. Close is serialized, idempotent, failure-aggregating, and
    never reopens a closed database or permits retained owner capabilities to write. Shadow is
    observational, including terminal/replay paths: it may record private bounded observations but
    cannot suppress a normal OpenClaw retry, steer, stop, interrupt, alter tools, or alter replies.

42. Child admission and lifecycle use one controller-scoped durable child-intent identity. Named
    requests are keyed by the normalized operation key; unnamed requests use the canonical request
    digest. The child-intent row is the CAS authority for reservation, dispatch, cancellation,
    registration, terminal state, attempt generation, and compact replay high-water. Gateway
    acceptance data is bound to that row and its exact request/resolved/delivery digests in the
    same state-database transaction; process-local maps are only caches. `subagent_runs` remains a
    projection and cannot prune or overwrite another lifecycle row. Explicit operation-key reuse
    with changed behavior is a conflict, while distinct named slots remain distinct. Terminal rows
    retain only bounded identity, binding, generation, and outcome proof; raw task payload is
    compacted. Ambiguous dispatch is adopted or fenced from a durable receipt and is never retried
    from timeout or missing in-memory state; only a proven pre-acceptance failure can allocate a
    successor attempt. Governor OFF retains the legacy child path and has no receipt or signer
    dependency.

## Consequences

This adds durable state and explicit lifecycle code, but avoids a second execution engine. Existing
task and delivery implementations remain authoritative for performing work; the governor decides
when work is admissible, sufficient, verified, and deliverable. Schema additions are additive and
can remain unused indefinitely while the feature flag is off.

## Rollout prerequisites

The governor remains disabled by default. A future production rollout must first provide host-held
`OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY`, `OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY`,
`OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY`, and
`OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY` as four independently provisioned keys, set a stable
`OPENCLAW_GOVERNOR_DEPLOYMENT_ID`, configure authenticated evidence, approval, delivery,
owner-ingress, and child-lifecycle integration owners, bind each owner
channel/account/gateway/principal/action/scope tuple,
register/certify at least one compiled host-owned channel implementation, and install concrete
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
`governor-host-delivery-broker.ts`, `governor-host-delivery-implementations.ts`,
`governor-host-delivery-persistence.ts`, the generated delivery build manifest,
`governor-host-channel-delivery.ts`, `governor-host-owner-ingress.ts`,
`governor-host-persistence.ts`, `governor-host-owner-ingress-persistence.ts`,
`governor-host-memory-authority.ts`, `governor-host-task-authority.ts`,
`governor-host-secrets.ts`, and the anti-rollback ledger codec/storage form the private host
boundary. They are
not in the package export map. A whole-source allowlist permits only the explicit trusted bootstrap
and host-internal dependency edges. Governor, task, model, and plugin code may
consume read-only resolvers from `governor-host-readonly.ts`, but must not import the broker or a
capability constructor. The static boundary test enforces that edge. Test-only synthetic bindings
are rejected unless `NODE_ENV=test`; they are never a production fallback.

The host ledger sidecars are private and store only opaque stream keys, digests, generations,
signed task fences, and signatures. The append-only journal and independently signed full-state
head can repair one missing or corrupt copy and are separate from replayable governor SQLite
tables. If both disappear after governor state exists, bootstrap fails closed instead of creating a
new trust root. A full host/OS snapshot that replays both sidecars together remains outside this
software boundary; hardware or remote monotonic storage is required for that stronger rollback
guarantee.

At a future live rollout, authenticated terminal, UI, and channel integrations must hold separate
narrow evidence, approval/revocation, delivery, owner-ingress, and child-lifecycle capabilities
returned only by trusted bootstrap. The task-facing controller receives read-only resolvers.
Bootstrap fails closed without all five integration owners, an owner binding, and at least one
certified delivery
implementation. The broker retains signing
keys in the runtime secret provider only; SQLite
stores opaque IDs, key IDs/versions, signatures, payload/semantic digests, grants, and monotonic
epoch/generation high-water marks. Rotation creates a new key/version and accepts only explicitly
configured active verification versions. Restart reconstructs state from durable signed records;
revocation high-water marks fence old grants and delivery generations.

Delivery registration resolves a compiled host-owned implementation by allowlisted ID and binds a
deep-cloned, deep-frozen non-secret configuration snapshot. It never accepts or retains a
caller-owned function, closure, object, factory, or registry. A later mutation of the caller's
descriptor or nested configuration cannot change dispatch. Production currently has no certified
channel integration: compiled Signal, iMessage, and disposable-canary implementations exist, but no
live host configuration, owner binding, certification, or routing activation is part of this branch.
If no authenticated host integration exists, startup must remain
fail-closed and the feature must remain disabled. `emitTrustedDiagnosticEvent` is explicitly
inadmissible: it is a diagnostic API rather than an authenticated authority boundary and must never
issue a governor receipt, approval, or adapter certification.
