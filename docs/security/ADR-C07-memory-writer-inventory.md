# C07 legacy memory writer elimination inventory

Status: proposed normative companion to `ADR-C07-memory-authority-redesign.md`. Implementation is
blocked until the complete C07 design receives an independent Sol High GO.

This inventory is exhaustive for the `68a28d` C07 memory surface. Each named writer is deleted or
reduced to a projection-only operation. A generated architecture inventory must fail readiness if
a writer, mutation verb, direct SQL owner, or key-bearing factory exists outside this table.

| Existing surface                                                                                     | Authority defect                                                                  | Required disposition                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryGovernorBackend.admit`                                                                        | Public backend contract admits outside the control ledger.                        | Remove. Trusted core submits `ADMIT`; only its committed event reaches projection.                                                 |
| `GovernorMemoryLanceDbAdapter.admit`                                                                 | Adapter authenticates and writes directly.                                        | Delete. Adapter accepts only immutable `applyProjectionEvent` input.                                                               |
| `GovernorMemoryLedger.admit` and direct index/revision writes in `governor-memory-ledger.ts`         | LanceDB allocates authority state in an independent transaction.                  | Delete as authority. Event application alone writes the projection row and indexes.                                                |
| `GovernorMemoryStore.promoteVerified` and direct candidate/verified inserts in `memory-integrity.ts` | Host-side store can establish current verified memory without the control ledger. | Replace with control-ledger `ADMIT` or `REPLACE`; the store becomes an authoritative-ledger read facade or is removed.             |
| `GovernorMemorySubsystem.promoteVerified`                                                            | Commits primary state and later queues backend projection.                        | Replace with one control-ledger transition whose transaction emits the outbox event.                                               |
| `GovernorMemorySubsystem.resolveContradiction`                                                       | Primary invalidation and backend invalidation can diverge.                        | Route the complete contradiction decision through `CONTRADICT` or `REPLACE`; never call a backend invalidator.                     |
| `GovernorMemoryContradictionStore.resolve`                                                           | Directly retires a stale row and inserts its replacement.                         | Remove as a writer. It may validate a proposal, but the control-ledger transaction owns both states and lineage.                   |
| `MemoryGovernorBackend.invalidate`                                                                   | Public unsigned invalidation accepts caller reason/time.                          | Remove. Callers submit evidence/proposals to the closed transition API.                                                            |
| `GovernorMemoryLanceDbAdapter.invalidate`                                                            | Forwards unsigned replacement/tombstone requests.                                 | Delete. Projection exposes only event application and bounded reads.                                                               |
| `GovernorMemoryLedger.invalidate`                                                                    | Derives generation, cutoff, impact, and replacement inside LanceDB.               | Delete. It applies exact target state from one signed event.                                                                       |
| `GovernorMemoryBackend.retire` and `GovernorMemoryLedger.retire`                                     | Creates a second retirement command surface.                                      | Delete. Expiry, forget, tamper, source invalidation, and supersession are control-ledger transitions.                              |
| `retireGovernorFact` calls from admit/invalidate/retire paths                                        | Helper is reachable from multiple semantic owners.                                | Make private to projection event application and dispatch only on the event transition type.                                       |
| `GovernorMemorySubsystem.quarantine`, `forget`, and `reconcile` status writers                       | Primary and backend can commit different state or order.                          | Replace with one typed control-ledger command; callers receive its committed authority result.                                     |
| Lazy recall quarantine/retirement                                                                    | A read can create new authority state.                                            | Recall filters against authoritative eligibility and may request idempotent projection repair only.                                |
| Remediation queue writers outside the authority transaction                                          | Queue contents can imply a transition absent from authority.                      | Remove. The transactional signed outbox is the sole remediation source.                                                            |
| Source-evidence invalidation hooks that update memory rows directly                                  | Derived memory can be retired outside bounded lineage traversal.                  | Route to `INVALIDATE_SOURCE`; the ledger atomically updates the full bounded descendant set and emits events.                      |
| Expiry sweepers that update candidate/verified/projection rows                                       | Scheduler independently derives cutoff/current state.                             | Scheduler proposes the fact and authenticated time; the ledger executes `EXPIRE` and fixes the signed cutoff.                      |
| `DurableMemoryRuntime.createGovernorMemoryBackend` and caller-selected `authorityBindingKey`         | Plugin/runtime code can construct apparent authority.                             | Remove from plugin/runtime exports. Trusted supervisor constructs internal ledger and projection worker from its startup snapshot. |
| Direct SQL writes to authority, current, lineage, outbox, projection high-water, or migration tables | Bypasses the state machine or event protocol.                                     | Generated durable-boundary inventory permits only named control-ledger transactions or projection event application.               |
| Migration/backfill code that promotes from unsigned rows                                             | Infers authority from legacy bytes or timestamps.                                 | Offline migration emits `MIGRATE_REBUILD` only from provable signed history; otherwise `MIGRATE_QUARANTINE`.                       |
| Projection rebuild/compaction code that changes semantic state                                       | Rebuild can become an alternate authority.                                        | Rebuild applies signed checkpoints/events verbatim; compaction cannot change current rows, cutoffs, generations, or fences.        |

## Closed post-redesign write surface

Only two durable write owners remain:

1. named control-ledger transactions update authority/current/lineage and append a signed immutable
   projection event to the outbox in the same SQLite transaction; and
2. the projection worker applies that exact event idempotently through `applyProjectionEvent` and
   records a receipt. It cannot allocate or reinterpret authority.

Every legacy caller maps to one closed transition (`ADMIT`, `REPLACE`, `CONTRADICT`, `SUPERSEDE`,
`EXPIRE`, `FORGET`, `TAMPER`, `INVALIDATE_SOURCE`, `ADVANCE_AUTHORITY_EPOCH`,
`ADVANCE_SCOPE_EPOCH`, `MIGRATE_REBUILD`, or `MIGRATE_QUARANTINE`). No generic mutation command is
permitted.

## Closing checks

- Static AST and export-map tests enumerate every implementation of the removed methods and every
  SQL writer touching C07 tables; the expected set is exact, not allow-by-prefix.
- Runtime negative tests prove retained legacy facades cannot mutate authority or projection.
- Transition tests exercise each legacy entry point's replacement path and verify one authority
  event, one outbox row, and idempotent projection application.
- Readiness binds the inventory hash; unknown or missing entries prevent activation.
