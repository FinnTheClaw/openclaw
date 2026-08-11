/** Host-owned three-slot physical execution ledger and anti-rollback fence. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type {
  GovernorHostAntiRollbackLedger,
  GovernorLedgerState,
} from "./governor-host-anti-rollback-ledger.js";

export const GOVERNOR_PHYSICAL_EXECUTION_SLOTS = 3;

export type GovernorPhysicalExecutionBinding = Readonly<{
  jobId: string;
  taskId: string;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  claimEpoch: number;
  workerIdentity: string;
}>;

export type GovernorPhysicalExecutionLease = Readonly<{
  slot: number;
  generation: number;
  bindingDigest: string;
}>;

export type GovernorPhysicalExecutionState = GovernorPhysicalExecutionLease &
  Readonly<{
    status: "cancel_pending" | "claimed" | "completed" | "crashed" | "terminated";
    ledgerDigest: string;
  }>;

export type GovernorTrustedPhysicalExecutionCoordinator = Readonly<{
  claim: (
    binding: GovernorPhysicalExecutionBinding,
  ) =>
    | Readonly<{ kind: "claimed"; lease: GovernorPhysicalExecutionLease }>
    | Readonly<{ kind: "already_active"; lease: GovernorPhysicalExecutionLease }>
    | Readonly<{ kind: "saturated" }>;
  requestCancellation: (
    binding: GovernorPhysicalExecutionBinding,
    lease: GovernorPhysicalExecutionLease,
  ) => GovernorPhysicalExecutionLease | null;
  complete: (
    binding: GovernorPhysicalExecutionBinding,
    lease: GovernorPhysicalExecutionLease,
  ) => boolean;
  acknowledgeTermination: (
    binding: GovernorPhysicalExecutionBinding,
    lease: GovernorPhysicalExecutionLease,
    outcome: "crashed" | "terminated",
  ) => GovernorPhysicalExecutionLease | null;
  acknowledgeOrphanedTermination: (
    lease: GovernorPhysicalExecutionLease,
    outcome: "crashed" | "terminated",
  ) => GovernorPhysicalExecutionLease | null;
  state: (slot: number) => GovernorPhysicalExecutionState | null;
}>;

const COORDINATORS = new WeakSet<object>();
const slotKey = (slot: number) => `physical-slot:${slot}`;
const bindingDigest = (binding: GovernorPhysicalExecutionBinding) => governorDigest(binding);

function assertLease(lease: GovernorPhysicalExecutionLease): void {
  if (
    !Number.isInteger(lease.slot) ||
    lease.slot < 0 ||
    lease.slot >= GOVERNOR_PHYSICAL_EXECUTION_SLOTS ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1 ||
    !lease.bindingDigest
  ) {
    throw new Error("Governor physical execution lease is invalid");
  }
}

function toState(
  slot: number,
  state: GovernorLedgerState | null,
): GovernorPhysicalExecutionState | null {
  if (
    !state ||
    !["cancel_pending", "claimed", "completed", "crashed", "terminated"].includes(state.status)
  ) {
    return null;
  }
  return {
    slot,
    generation: state.generation,
    bindingDigest: state.bindingDigest,
    status: state.status as GovernorPhysicalExecutionState["status"],
    ledgerDigest: state.digest,
  };
}

function matches(
  state: GovernorLedgerState | null,
  lease: GovernorPhysicalExecutionLease,
  digest: string,
): boolean {
  return (
    state?.generation === lease.generation &&
    state.bindingDigest === digest &&
    lease.bindingDigest === digest
  );
}

/** Created only by the host broker from its private anti-rollback persistence port. */
export function createGovernorPhysicalExecutionCoordinator(
  ledger: GovernorHostAntiRollbackLedger,
): GovernorTrustedPhysicalExecutionCoordinator {
  const coordinator: GovernorTrustedPhysicalExecutionCoordinator = Object.freeze({
    claim: (binding) => {
      const digest = bindingDigest(binding);
      for (let slot = 0; slot < GOVERNOR_PHYSICAL_EXECUTION_SLOTS; slot += 1) {
        const current = ledger.state("execution", slotKey(slot));
        if (
          current?.bindingDigest === digest &&
          (current.status === "claimed" || current.status === "cancel_pending")
        ) {
          return {
            kind: "already_active",
            lease: { slot, generation: current.generation, bindingDigest: digest },
          };
        }
      }
      for (let slot = 0; slot < GOVERNOR_PHYSICAL_EXECUTION_SLOTS; slot += 1) {
        const current = ledger.state("execution", slotKey(slot));
        if (current && (current.status === "claimed" || current.status === "cancel_pending")) {
          continue;
        }
        const next = ledger.append({
          kind: "execution",
          key: slotKey(slot),
          generation: (current?.generation ?? 0) + 1,
          status: "claimed",
          bindingDigest: digest,
        });
        return {
          kind: "claimed",
          lease: { slot, generation: next.generation, bindingDigest: digest },
        };
      }
      return { kind: "saturated" };
    },
    requestCancellation: (binding, lease) => {
      assertLease(lease);
      const digest = bindingDigest(binding);
      const current = ledger.state("execution", slotKey(lease.slot));
      if (
        current?.status === "cancel_pending" &&
        current.bindingDigest === digest &&
        lease.bindingDigest === digest &&
        current.generation >= lease.generation
      ) {
        return { slot: lease.slot, generation: current.generation, bindingDigest: digest };
      }
      if (!matches(current, lease, digest) || current?.status !== "claimed") {
        return null;
      }
      const next = ledger.append({
        kind: "execution",
        key: slotKey(lease.slot),
        generation: current.generation + 1,
        status: "cancel_pending",
        bindingDigest: digest,
      });
      return { slot: lease.slot, generation: next.generation, bindingDigest: digest };
    },
    complete: (binding, lease) => {
      assertLease(lease);
      const digest = bindingDigest(binding);
      const current = ledger.state("execution", slotKey(lease.slot));
      if (current?.status === "completed" && current.bindingDigest === digest) {
        return true;
      }
      if (!matches(current, lease, digest) || current?.status !== "claimed") {
        return false;
      }
      ledger.append({
        kind: "execution",
        key: slotKey(lease.slot),
        generation: current.generation + 1,
        status: "completed",
        bindingDigest: digest,
      });
      return true;
    },
    acknowledgeTermination: (binding, lease, outcome) => {
      assertLease(lease);
      const digest = bindingDigest(binding);
      const current = ledger.state("execution", slotKey(lease.slot));
      if (current?.status === outcome && current.bindingDigest === digest) {
        return { slot: lease.slot, generation: current.generation, bindingDigest: digest };
      }
      if (!matches(current, lease, digest) || current?.status !== "cancel_pending") {
        return null;
      }
      const next = ledger.append({
        kind: "execution",
        key: slotKey(lease.slot),
        generation: current.generation + 1,
        status: outcome,
        bindingDigest: digest,
      });
      return { slot: lease.slot, generation: next.generation, bindingDigest: digest };
    },
    acknowledgeOrphanedTermination: (lease, outcome) => {
      assertLease(lease);
      const current = ledger.state("execution", slotKey(lease.slot));
      if (current?.status === outcome && current.bindingDigest === lease.bindingDigest) {
        return {
          slot: lease.slot,
          generation: current.generation,
          bindingDigest: lease.bindingDigest,
        };
      }
      if (!matches(current, lease, lease.bindingDigest) || current?.status !== "cancel_pending") {
        return null;
      }
      const next = ledger.append({
        kind: "execution",
        key: slotKey(lease.slot),
        generation: current.generation + 1,
        status: outcome,
        bindingDigest: lease.bindingDigest,
      });
      return { slot: lease.slot, generation: next.generation, bindingDigest: lease.bindingDigest };
    },
    state: (slot) => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= GOVERNOR_PHYSICAL_EXECUTION_SLOTS) {
        return null;
      }
      return toState(slot, ledger.state("execution", slotKey(slot)));
    },
  });
  COORDINATORS.add(coordinator);
  return coordinator;
}

export function isTrustedGovernorPhysicalExecutionCoordinator(
  value: GovernorTrustedPhysicalExecutionCoordinator,
): boolean {
  return COORDINATORS.has(value);
}
