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

## Consequences

This adds durable state and explicit lifecycle code, but avoids a second execution engine. Existing
task and delivery implementations remain authoritative for performing work; the governor decides
when work is admissible, sufficient, verified, and deliverable. Schema additions are additive and
can remain unused indefinitely while the feature flag is off.
