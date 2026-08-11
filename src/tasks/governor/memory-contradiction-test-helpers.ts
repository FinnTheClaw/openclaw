// Synthetic host/task helpers for memory contradiction and remediation tests.
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GovernorJsonValue } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { createGovernorEventRecord } from "./events.js";
import { createGovernorEvidenceCandidate, type GovernorEvidenceSourceKind } from "./evidence.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import type { GovernorMemoryRepairAction } from "./memory-remediation-runtime.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore } from "./test-broker.js";
import type {
  GovernorPlan,
  GovernorTaskContract,
  GovernorTaskId,
  GovernorTaskProjection,
  GovernorTaskScope,
} from "./types.js";

export const memoryScopeA: GovernorTaskScope = {
  principalId: "principal-memory-a",
  channel: "synthetic",
  accountId: "account-memory-a",
  conversationId: "conversation-memory-a",
  sessionId: "session-memory-a",
  agentId: "agent-memory",
  workspaceId: "workspace-memory-a",
};

export const memoryScopeB: GovernorTaskScope = {
  ...memoryScopeA,
  principalId: "principal-memory-b",
  conversationId: "conversation-memory-b",
  sessionId: "session-memory-b",
  workspaceId: "workspace-memory-b",
};

const contract: GovernorTaskContract = {
  objective: "Repair one stale canonical memory source",
  constraints: ["Use only synthetic evidence"],
  knownFacts: [],
  unknowns: ["current path"],
  completionCriteria: [
    { criterionId: "memory-observed", description: "Current path observed", mandatory: true },
    { criterionId: "repair-verified", description: "Canonical source repaired", mandatory: true },
  ],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: ["synthetic.memory.repair"],
    canonicalTargets: ["fixture://canonical-memory-source"],
  },
};

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [
    {
      stepId: "repair-memory",
      description: "Repair and verify the canonical source",
      criterionIds: ["memory-observed", "repair-verified"],
      dependsOn: [],
    },
  ],
};

export function memoryTestRegistry() {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.memory.repair",
      version: "1",
      sourceRank: "structured_exact",
      mutating: true,
      canonicalTargetPrefixes: ["fixture://canonical-memory-source"],
      requiresApproval: false,
    },
  ]);
}

export function memoryRepairAction(): GovernorMemoryRepairAction {
  return {
    criterionId: "repair-verified",
    capability: "synthetic.memory.repair",
    capabilityVersion: "1",
    canonicalTarget: "fixture://canonical-memory-source",
    expectedEvidence: "Fresh canonical source value",
    sourceRank: "structured_exact",
    stopCondition: "Canonical source returns the replacement value",
    argumentsDigest: governorArgumentsDigest({ operation: "repair-canonical-memory" }),
  };
}

export type MemoryTestHarness = ReturnType<typeof createGovernorTestStore> & {
  controller: GovernorController;
  stateDir: string;
};

export async function withMemoryTestHarness(
  run: (harness: MemoryTestHarness) => Promise<void> | void,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-governor-memory-contradiction-" },
    async (state) => {
      const capabilities = memoryTestRegistry();
      const testStore = createGovernorTestStore({
        stateDir: state.stateDir,
        capabilities,
      });
      try {
        await run({
          ...testStore,
          controller: new GovernorController(testStore.store, capabilities),
          stateDir: state.stateDir,
        });
      } finally {
        closeOpenClawStateDatabase();
      }
    },
  );
}

export function startMemoryTestTask(
  controller: GovernorController,
  scope: GovernorTaskScope,
  sequence = 1,
): GovernorTaskId {
  const taskId = controller.ingest({
    sourceMessageId: `memory-message-${sequence}`,
    sourceSequence: sequence,
    scope,
    mode: "FOCUSED",
    contract,
    now: 10 + sequence,
  }).task.taskId;
  controller.preparePlan({ taskId, plan, now: 20 + sequence * 10 });
  controller.startExecution(taskId, 24 + sequence * 10);
  return taskId;
}

export function correctMemoryTestTask(
  controller: GovernorController,
  scope: GovernorTaskScope,
  sequence = 2,
): GovernorTaskId {
  return controller.ingest({
    sourceMessageId: `memory-message-${sequence}`,
    sourceSequence: sequence,
    scope,
    mode: "FOCUSED",
    contract: { ...contract, objective: "Corrected memory objective" },
    now: 100 + sequence,
  }).task.taskId;
}

export function seedMemoryFact(params: {
  store: GovernorSqliteStore;
  broker: ReturnType<typeof createGovernorTestStore>["broker"];
  taskId: GovernorTaskId;
  scope: GovernorTaskScope;
  memoryId: string;
  factKey: string;
  path: string;
  observedAt: number;
  sourceKind?: "tool" | "structured_external";
}) {
  const evidenceId = `seed-evidence-${params.memoryId}`;
  persistMemoryEvidence({
    store: params.store,
    broker: params.broker,
    taskId: params.taskId,
    evidenceId,
    criterionId: "memory-observed",
    predicate: governorMemoryFactPredicate(params.factKey),
    value: { path: params.path },
    observedAt: params.observedAt,
    sourceKind: params.sourceKind ?? "tool",
  });
  const result = params.store.memory.promoteVerified({
    taskId: params.taskId,
    evidenceId,
    memoryId: params.memoryId,
    factKey: params.factKey,
    scope: params.scope,
    expectedScopeEpoch: 0,
    now: params.observedAt,
  });
  if (!result.stored) {
    throw new Error(`failed to seed memory: ${result.reason}`);
  }
  return result.memory;
}

export function persistMemoryEvidence(params: {
  store: GovernorSqliteStore;
  broker: ReturnType<typeof createGovernorTestStore>["broker"];
  taskId: GovernorTaskId;
  evidenceId: string;
  criterionId: "memory-observed" | "repair-verified";
  predicate: string;
  value: GovernorJsonValue;
  observedAt: number;
  sourceKind?: Extract<
    GovernorEvidenceSourceKind,
    "authenticated_user" | "tool" | "structured_external"
  >;
  sourceIdentity?: string;
}): GovernorTaskProjection {
  const task = params.store.loadTask(params.taskId);
  if (!task) {
    throw new Error("missing governor task");
  }
  const sourceKind = params.sourceKind ?? "structured_external";
  const sourceIdentity = params.sourceIdentity ?? "synthetic-canonical-source";
  const receiptId = params.broker.capabilities.submitObservedReceipt({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    sourceKind,
    sourceIdentity,
    payload: params.value,
    observedAt: params.observedAt,
  });
  const admission = params.store.admitEvidenceCandidate({
    task,
    candidate: createGovernorEvidenceCandidate({
      evidenceId: params.evidenceId,
      taskId: task.taskId,
      criterionId: params.criterionId,
      sourceKind,
      sourceIdentity,
      taskVersion: task.taskVersion,
      objectiveRevision: task.objectiveRevision,
      planVersion: task.planVersion,
      scopeKey: task.scopeKey,
      observedAt: params.observedAt,
      payload: params.value,
      predicate: params.predicate,
      value: params.value,
    }),
    receiptId,
    now: params.observedAt,
  });
  const next = { ...task, taskVersion: task.taskVersion + 1, updatedAt: params.observedAt };
  const event = createGovernorEventRecord({
    task: next,
    eventType: "evidence_admitted",
    payload: { evidenceId: params.evidenceId },
    now: params.observedAt,
  });
  const committed = params.store.commit({
    current: task,
    next,
    event,
    evidenceAdmission: admission,
  });
  if (!committed.applied) {
    throw new Error(`failed to persist evidence: ${committed.reason}`);
  }
  return committed.task;
}
