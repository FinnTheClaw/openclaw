// Covers unbounded useful deep work and revision-fenced evidence as mandatory replay gates.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { createGovernorTestStore, recordGovernorTestToolOutcome } from "./test-broker.js";
import { createGovernorEffectId, type GovernorPlan, type GovernorTaskScope } from "./types.js";

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [{ stepId: "verify", description: "Verify", criterionIds: ["verified"], dependsOn: [] }],
};

function scope(index: number): GovernorTaskScope {
  return {
    principalId: `principal-deep-${index}`,
    channel: "synthetic",
    accountId: `account-deep-${index}`,
    conversationId: `conversation-deep-${index}`,
    sessionId: `session-deep-${index}`,
    agentId: "agent-deep",
    workspaceId: "workspace-deep",
  };
}

function contract(objective: string) {
  return {
    objective,
    constraints: ["Use synthetic fixtures"],
    knownFacts: [],
    unknowns: ["final state"],
    completionCriteria: [{ criterionId: "verified", description: "Verified", mandatory: true }],
    authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
  };
}

function deepCapabilities(): GovernorCapabilityRegistry {
  return new GovernorCapabilityRegistry([
    {
      capability: "synthetic.inspect",
      version: "1",
      sourceRank: "structured_exact",
      mutating: false,
      canonicalTargetPrefixes: ["fixture://"],
      requiresApproval: false,
    },
  ]);
}

function recordEvidence(
  governor: GovernorController,
  broker: ReturnType<typeof createGovernorTestStore>["broker"],
  taskId: ReturnType<GovernorController["ingest"]>["task"]["taskId"],
  suffix: string,
  now: number,
) {
  recordGovernorTestToolOutcome(governor, broker, {
    taskId,
    executionFence: governor.captureExecutionFence(taskId),
    proposal: {
      effectId: createGovernorEffectId(suffix),
      criterionId: "verified",
      capability: "synthetic.inspect",
      capabilityVersion: "1",
      canonicalTarget: `fixture://${suffix}`,
      expectedEvidence: "Exact item",
      sourceRank: "structured_exact",
      stopCondition: "Item verified",
      mutating: false,
      argumentsDigest: governorArgumentsDigest({ suffix }),
    },
    progressVector: { suffix },
    outcome: {
      transport: "completed",
      semantic: "success",
      sideEffect: "not_applicable",
      verification: "not_required",
      summaryCode: "verified",
      evidence: { suffix, verified: true },
    },
    now,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor deep mandatory replay", () => {
  it("permits 35 useful actions and rejects evidence from a prior correction", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-deep-eval-" },
      async (state) => {
        const capabilities = deepCapabilities();
        const { store, broker } = createGovernorTestStore({
          stateDir: state.stateDir,
          capabilities,
        });
        const governed = new GovernorController(store, capabilities);
        try {
          const taskId = governed.ingest({
            sourceMessageId: "deep-message-1",
            sourceSequence: 1,
            scope: scope(1),
            mode: "DEEP",
            contract: contract("Run 35 useful exact checks"),
            now: 100,
          }).task.taskId;
          governed.preparePlan({ taskId, plan, now: 110 });
          governed.startExecution(taskId, 120);
          for (let index = 0; index < 35; index += 1) {
            recordEvidence(governed, broker, taskId, `deep-${index}`, 121 + index);
          }
          expect(store.listEffects(taskId)).toHaveLength(35);
          governed.beginVerification(taskId, 200);
          expect(
            governed.proposeFinish({
              taskId,
              response: { framing: "summary", materialClaimIds: [] },
              now: 201,
            }).completed,
          ).toBe(true);

          const correctedTaskId = governed.ingest({
            sourceMessageId: "revision-message-1",
            sourceSequence: 1,
            scope: scope(2),
            mode: "FOCUSED",
            contract: contract("Original revision"),
            now: 300,
          }).task.taskId;
          governed.preparePlan({ taskId: correctedTaskId, plan, now: 310 });
          governed.startExecution(correctedTaskId, 320);
          recordEvidence(governed, broker, correctedTaskId, "old-revision", 321);
          governed.ingest({
            sourceMessageId: "revision-message-2",
            sourceSequence: 2,
            scope: scope(2),
            mode: "FOCUSED",
            contract: contract("Corrected revision"),
            now: 322,
          });
          governed.preparePlan({ taskId: correctedTaskId, plan, now: 330 });
          governed.startExecution(correctedTaskId, 340);
          governed.beginVerification(correctedTaskId, 341);
          const rejected = governed.proposeFinish({
            taskId: correctedTaskId,
            response: { framing: "summary", materialClaimIds: [] },
            now: 342,
          });
          expect(rejected.completed).toBe(false);
          if (!rejected.completed) {
            expect(rejected.recovery.unmetCriteria).toEqual(["verified"]);
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
