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
13. A mutating capability that requires approval accepts only a host-authenticated opaque grant ID.
    The durable grant is bound to task scope, objective revision, capability/version, canonical
    target, expiry, and revocation state; a model proposal cannot mint or extend it.
14. Completion reads durable claims, contradictions, pending-update state, and evidence for the
    current objective and plan only. Corrections cancel old action/fan-out generations and make
    late results audit-only.
15. A host-owned, HMAC-signed certification record, not a delivery provider's self-attestation,
    authorizes stable delivery-key deduplication before the outbox will claim or send an entry.
    Certification binds adapter identity, version, and capability; revocation is durable and final.
    Provider receipts are secret-filtered before persistence.
16. The built-in memory adapter truthfully guarantees primary tombstone plus scope-epoch fencing.
    Cache/index/embedding invalidation requires a concrete adapter and must not be reported until
    such an adapter provides verified postconditions.
17. Evidence source identities are converted at the durable admission boundary to branded keyed
    opaque references. Admission records a canonical predicate/value digest; a material response
    claim must exactly match that digest. Legacy evidence rows receive an impossible plan-version
    sentinel and therefore cannot satisfy a current plan until freshly re-admitted.
18. A response may contain only fixed non-material framing plus deterministic rendering of durable
    material claims bound to the current objective and plan and supported by admitted evidence.
19. Mandatory governor metrics are calculated from append-only deterministic scenario execution
    logs, including duplicate ingress and crash-recovery paths; attempts and observable effects are
    counted separately, and static samples are not evidence.

## Consequences

This adds durable state and explicit lifecycle code, but avoids a second execution engine. Existing
task and delivery implementations remain authoritative for performing work; the governor decides
when work is admissible, sufficient, verified, and deliverable. Schema additions are additive and
can remain unused indefinitely while the feature flag is off.

## Rollout prerequisites

The governor remains disabled by default. A future production rollout must first provide host-held
`OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY` and `OPENCLAW_GOVERNOR_DELIVERY_CERTIFICATION_KEY`,
certify each selected channel adapter through durable host configuration, and install concrete
cache/index/embedding invalidation adapters for every governed memory backend. Until then, this is
a synthetic-testable control plane rather than a live message-path replacement.
