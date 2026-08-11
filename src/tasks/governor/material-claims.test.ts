// Proves completion text can contain only durable, current evidence-linked material claims.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorController, governorArgumentsDigest } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorEffectId, type GovernorPlan, type GovernorTaskScope } from "./types.js";

function scope(index: number): GovernorTaskScope {
  return {
    principalId: `principal-material-${index}`,
    channel: "synthetic",
    accountId: `account-material-${index}`,
    conversationId: `conversation-material-${index}`,
    sessionId: `session-material-${index}`,
    agentId: "agent-material",
    workspaceId: "workspace-material",
  };
}

const plan: GovernorPlan = {
  kind: "ordered",
  steps: [{ stepId: "verify", description: "Verify", criterionIds: ["verified"], dependsOn: [] }],
};

function controller(store: GovernorSqliteStore): GovernorController {
  return new GovernorController(
    store,
    new GovernorCapabilityRegistry([
      {
        capability: "synthetic.inspect",
        version: "1",
        sourceRank: "structured_exact",
        mutating: false,
        canonicalTargetPrefixes: ["fixture://"],
        requiresApproval: false,
      },
    ]),
  );
}

function verifiedTask(controller: GovernorController, index: number) {
  const taskScope = scope(index);
  const base = 100 + index * 100;
  const taskId = controller.ingest({
    sourceMessageId: `material-message-${index}`,
    sourceSequence: 1,
    scope: taskScope,
    mode: "FOCUSED",
    contract: {
      objective: "Produce a supported result",
      constraints: [],
      knownFacts: [],
      unknowns: [],
      completionCriteria: [{ criterionId: "verified", description: "Verified", mandatory: true }],
      authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
    },
    now: base,
  }).task.taskId;
  controller.preparePlan({ taskId, plan, now: base + 1 });
  controller.startExecution(taskId, base + 5);
  const outcome = controller.recordToolOutcome({
    taskId,
    executionFence: controller.captureExecutionFence(taskId),
    proposal: {
      effectId: createGovernorEffectId("material-evidence"),
      criterionId: "verified",
      capability: "synthetic.inspect",
      capabilityVersion: "1",
      canonicalTarget: "fixture://verified",
      expectedEvidence: "Exact synthetic state",
      sourceRank: "structured_exact",
      stopCondition: "State verified",
      mutating: false,
      argumentsDigest: governorArgumentsDigest({ target: "verified" }),
    },
    progressVector: { verified: true },
    outcome: {
      transport: "completed",
      semantic: "success",
      sideEffect: "not_applicable",
      verification: "not_required",
      summaryCode: "verified",
      evidence: { state: "verified" },
    },
    now: base + 6,
  });
  if (!outcome.accepted || !outcome.evidence) {
    throw new Error("expected current evidence");
  }
  controller.beginVerification(taskId, base + 7);
  return { taskId, evidenceId: outcome.evidence.evidenceId, scope: taskScope, base };
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor material response claims", () => {
  it("rejects unsupported and prose-only response claims, then delivers a current supported claim", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-material-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const governed = controller(store);
        try {
          const { taskId, evidenceId, scope: firstScope, base } = verifiedTask(governed, 1);
          expect(() =>
            governed.admitMaterialClaims({
              taskId,
              claims: [
                { claimId: "prose-only", text: "I think this is complete", evidenceIds: [] },
              ],
              now: 108,
            }),
          ).toThrow(/current evidence/);
          governed.admitMaterialClaims({
            taskId,
            claims: [
              {
                claimId: "old-material",
                text: "The old synthetic state is verified.",
                evidenceIds: [evidenceId],
              },
            ],
            now: base + 8,
          });
          governed.ingest({
            sourceMessageId: "material-message-1-correction",
            sourceSequence: 2,
            scope: firstScope,
            mode: "FOCUSED",
            contract: {
              objective: "Corrected synthetic result",
              constraints: [],
              knownFacts: [],
              unknowns: [],
              completionCriteria: [
                { criterionId: "verified", description: "Verified", mandatory: true },
              ],
              authority: {
                allowReadOnlyDiscovery: true,
                mutationCapabilities: [],
                canonicalTargets: [],
              },
            },
            now: base + 9,
          });
          governed.preparePlan({ taskId, plan, now: base + 10 });
          governed.startExecution(taskId, base + 14);
          governed.beginVerification(taskId, base + 15);
          const unsupported = governed.proposeFinish({
            taskId,
            response: { framing: "result", materialClaimIds: ["old-material"] },
            now: base + 16,
          });
          expect(unsupported).toMatchObject({
            completed: false,
            recovery: { unsupportedMaterialClaimIds: ["old-material"] },
          });

          const fresh = verifiedTask(governed, 2);
          governed.admitMaterialClaims({
            taskId: fresh.taskId,
            claims: [
              {
                claimId: "verified-state",
                text: "The synthetic state is verified.",
                evidenceIds: [fresh.evidenceId],
              },
            ],
            now: fresh.base + 8,
          });
          const completed = governed.proposeFinish({
            taskId: fresh.taskId,
            response: { framing: "result", materialClaimIds: ["verified-state"] },
            now: fresh.base + 9,
          });
          expect(completed.completed).toBe(true);
          const payload = store.outbox.list(fresh.taskId)[0]?.payload;
          expect(payload).toMatchObject({
            text: "Verified result:\nThe synthetic state is verified.",
          });
          expect(evidenceId).toMatch(/^evidence_/);
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
