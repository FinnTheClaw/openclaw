// Host-owned monotonic task/objective/plan fence over the replayable primary database.
import {
  canonicalGovernorJson,
  governorDigest,
  type GovernorJsonValue,
} from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedJson } from "../tasks/governor/persistence-guard.js";
import type {
  GovernorHostAntiRollbackLedger,
  GovernorLedgerState,
  GovernorLedgerTaskFence,
} from "./governor-host-anti-rollback-ledger.js";

export type GovernorTaskFenceBinding = Readonly<{
  taskId: string;
  scopeKey: string;
  state: string;
  authenticatedSourceSequence: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  operationDigest: string;
  projection: GovernorJsonValue;
}>;

export type GovernorTaskFenceState = Readonly<{
  status: "intent" | "current";
  generation: number;
  bindingDigest: string;
  fence: GovernorLedgerTaskFence;
  priorFence?: GovernorLedgerTaskFence;
  priorBindingDigest?: string;
}>;

export type GovernorTrustedTaskAuthority = Readonly<{
  prepare: (binding: GovernorTaskFenceBinding) => GovernorTaskFenceState;
  finalize: (binding: GovernorTaskFenceBinding) => GovernorTaskFenceState;
  reconcile: (
    binding: GovernorTaskFenceBinding,
    strategy?: "target-only" | "target-or-prior",
  ) => boolean;
  matches: (binding: GovernorTaskFenceBinding) => boolean;
  state: (taskId: string) => GovernorTaskFenceState | null;
}>;

const AUTHORITIES = new WeakSet<object>();
const CLOSERS = new WeakMap<object, () => void>();

function authorityKey(taskId: string): string {
  return governorDigest({ kind: "governor-task-fence", taskId });
}

function taskFence(binding: GovernorTaskFenceBinding): GovernorLedgerTaskFence {
  return {
    scopeDigest: governorDigest({ scopeKey: binding.scopeKey }),
    authenticatedSourceSequence: binding.authenticatedSourceSequence,
    taskVersion: binding.taskVersion,
    objectiveRevision: binding.objectiveRevision,
    planVersion: binding.planVersion,
    leaseEpoch: binding.leaseEpoch,
    executionGeneration: binding.executionGeneration,
    stateDigest: governorDigest({ state: binding.state }),
    operationDigest: binding.operationDigest,
    projectionDigest: governorDigest(binding.projection),
  };
}

function bindingDigest(binding: GovernorTaskFenceBinding, fence = taskFence(binding)): string {
  return governorDigest({
    taskId: binding.taskId,
    scopeKey: binding.scopeKey,
    fence,
  });
}

function toState(state: GovernorLedgerState | null): GovernorTaskFenceState | null {
  if (!state?.taskFence || (state.status !== "task_intent" && state.status !== "task_current")) {
    return null;
  }
  return {
    status: state.status === "task_current" ? "current" : "intent",
    generation: state.generation,
    bindingDigest: state.bindingDigest,
    fence: state.taskFence,
    ...(state.priorTaskFence ? { priorFence: state.priorTaskFence } : {}),
    ...(state.priorBindingDigest ? { priorBindingDigest: state.priorBindingDigest } : {}),
  };
}

function sameState(state: GovernorLedgerState | null, binding: GovernorTaskFenceBinding): boolean {
  const fence = taskFence(binding);
  return (
    state?.bindingDigest === bindingDigest(binding, fence) &&
    state.taskFence !== undefined &&
    canonicalGovernorJson(state.taskFence) === canonicalGovernorJson(fence)
  );
}

function samePriorState(
  state: GovernorLedgerState | null,
  binding: GovernorTaskFenceBinding,
): boolean {
  const fence = taskFence(binding);
  return (
    state?.status === "task_intent" &&
    state.priorBindingDigest === bindingDigest(binding, fence) &&
    state.priorTaskFence !== undefined &&
    canonicalGovernorJson(state.priorTaskFence) === canonicalGovernorJson(fence)
  );
}

function sameInitialOperation(
  state: GovernorLedgerState | null,
  binding: GovernorTaskFenceBinding,
): boolean {
  return (
    state?.status === "task_intent" &&
    state.priorTaskFence === undefined &&
    state.taskFence?.operationDigest === binding.operationDigest &&
    state.taskFence.scopeDigest === taskFence(binding).scopeDigest &&
    state.taskFence.authenticatedSourceSequence === binding.authenticatedSourceSequence &&
    state.taskFence.taskVersion === 0 &&
    binding.taskVersion === 0
  );
}

function assertMonotonic(
  current: GovernorLedgerState | null,
  binding: GovernorTaskFenceBinding,
): void {
  const prior = current?.taskFence;
  if (!prior) {
    if (binding.taskVersion !== 0) {
      throw new Error("GOVERNOR_TASK_FENCE_INITIAL_VERSION_INVALID");
    }
    return;
  }
  if (
    binding.taskVersion !== prior.taskVersion + 1 ||
    binding.authenticatedSourceSequence < prior.authenticatedSourceSequence ||
    binding.objectiveRevision < prior.objectiveRevision ||
    binding.planVersion < prior.planVersion ||
    binding.leaseEpoch < prior.leaseEpoch ||
    binding.executionGeneration < prior.executionGeneration ||
    taskFence(binding).scopeDigest !== prior.scopeDigest
  ) {
    throw new Error("GOVERNOR_TASK_FENCE_REGRESSION");
  }
}

function validate(binding: GovernorTaskFenceBinding): void {
  assertGovernorPersistedJson("log", binding);
  if (
    !binding.taskId ||
    !binding.scopeKey ||
    !binding.state ||
    !Number.isSafeInteger(binding.authenticatedSourceSequence) ||
    !Number.isSafeInteger(binding.taskVersion) ||
    !Number.isSafeInteger(binding.objectiveRevision) ||
    !Number.isSafeInteger(binding.planVersion) ||
    !Number.isSafeInteger(binding.leaseEpoch) ||
    !Number.isSafeInteger(binding.executionGeneration) ||
    !/^[a-f0-9]{64}$/u.test(binding.operationDigest) ||
    binding.authenticatedSourceSequence < 0 ||
    binding.taskVersion < 0 ||
    binding.objectiveRevision < 0 ||
    binding.planVersion < 0 ||
    binding.leaseEpoch < 0 ||
    binding.executionGeneration < 0
  ) {
    throw new Error("GOVERNOR_TASK_FENCE_INPUT_INVALID");
  }
}

export function createGovernorTaskAuthority(
  ledger: GovernorHostAntiRollbackLedger,
  afterAppend?: () => void,
): GovernorTrustedTaskAuthority {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  };
  const append = (
    binding: GovernorTaskFenceBinding,
    status: "task_intent" | "task_current",
    current: GovernorLedgerState | null,
  ) => {
    assertOpen();
    validate(binding);
    const fence = taskFence(binding);
    const state = ledger.append({
      kind: "task",
      key: authorityKey(binding.taskId),
      generation: (current?.generation ?? -1) + 1,
      status,
      bindingDigest: bindingDigest(binding, fence),
      taskFence: fence,
      ...(status === "task_intent" && current?.status === "task_current" && current.taskFence
        ? {
            priorTaskFence: current.taskFence,
            priorBindingDigest: current.bindingDigest,
          }
        : {}),
    });
    afterAppend?.();
    return state;
  };
  const authority: GovernorTrustedTaskAuthority = Object.freeze({
    prepare: (binding) => {
      assertOpen();
      validate(binding);
      const current = ledger.state("task", authorityKey(binding.taskId));
      if (sameState(current, binding)) {
        const state = toState(current);
        if (!state) {
          throw new Error("GOVERNOR_TASK_FENCE_STATE_INVALID");
        }
        return state;
      }
      if (current?.status === "task_intent") {
        if (sameInitialOperation(current, binding)) {
          const state = toState(append(binding, "task_intent", current));
          if (!state) {
            throw new Error("GOVERNOR_TASK_FENCE_STATE_INVALID");
          }
          return state;
        }
        throw new Error("GOVERNOR_TASK_FENCE_INTENT_CONFLICT");
      }
      assertMonotonic(current, binding);
      const state = toState(append(binding, "task_intent", current));
      if (!state) {
        throw new Error("GOVERNOR_TASK_FENCE_STATE_INVALID");
      }
      return state;
    },
    finalize: (binding) => {
      assertOpen();
      validate(binding);
      const current = ledger.state("task", authorityKey(binding.taskId));
      if (!sameState(current, binding)) {
        throw new Error("GOVERNOR_TASK_FENCE_FINALIZE_MISMATCH");
      }
      if (current?.status === "task_current") {
        const state = toState(current);
        if (!state) {
          throw new Error("GOVERNOR_TASK_FENCE_STATE_INVALID");
        }
        return state;
      }
      if (current?.status !== "task_intent") {
        throw new Error("GOVERNOR_TASK_FENCE_FINALIZE_MISMATCH");
      }
      const state = toState(append(binding, "task_current", current));
      if (!state) {
        throw new Error("GOVERNOR_TASK_FENCE_STATE_INVALID");
      }
      return state;
    },
    reconcile: (binding, strategy = "target-only") => {
      assertOpen();
      validate(binding);
      const current = ledger.state("task", authorityKey(binding.taskId));
      if (current?.status === "task_current") {
        return sameState(current, binding);
      }
      if (current?.status !== "task_intent") {
        return false;
      }
      if (
        sameState(current, binding) ||
        (strategy === "target-or-prior" && samePriorState(current, binding))
      ) {
        append(binding, "task_current", current);
        return true;
      }
      return false;
    },
    matches: (binding) => {
      assertOpen();
      validate(binding);
      const current = ledger.state("task", authorityKey(binding.taskId));
      return current?.status === "task_current" && sameState(current, binding);
    },
    state: (taskId) => {
      assertOpen();
      return toState(ledger.state("task", authorityKey(taskId)));
    },
  });
  AUTHORITIES.add(authority);
  CLOSERS.set(authority, () => {
    closed = true;
  });
  return authority;
}

export function isTrustedGovernorTaskAuthority(value: GovernorTrustedTaskAuthority): boolean {
  return AUTHORITIES.has(value);
}

export function closeGovernorTaskAuthority(value: GovernorTrustedTaskAuthority): void {
  CLOSERS.get(value)?.();
}
