import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";
import type { HostGovernorEvidenceInvalidationReceiptId } from "./governor-host-contracts.js";

const capability: GovernorCapabilityDefinition = {
  capability: "v34.invalidation.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function environment(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "v34-invalidation-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "v34-invalidation-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "v34-invalidation-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "v34-invalidation-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "v34-invalidation-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "v34-invalidation-deployment",
  };
}

const criteria = [
  { criterionId: "alpha", description: "alpha" },
  { criterionId: "beta", description: "beta" },
];

function start(
  stateDir: string,
  configuredCriteria: readonly { criterionId: string; description: string }[] = criteria,
) {
  return createGovernorHostRuntimeIfEnabled({
    env: environment(),
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "v34-invalidation-evidence-owner",
      approvalOwnerId: "v34-invalidation-approval-owner",
      deliveryOwnerId: "v34-invalidation-delivery-owner",
      ownerIngressOwnerId: "v34-invalidation-ingress-owner",
      childOwnerId: "v34-invalidation-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "v34-invalidation-account",
          gatewayInstanceId: "v34-invalidation-gateway",
          ownerPrincipal: "v34-invalidation-principal",
          actions: ["repair"],
          scopeKeys: ["v34-invalidation-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey: "v34-invalidation-session" }],
        criteria: configuredCriteria,
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: Object.fromEntries(
              configuredCriteria.map((item) => [item.criterionId, item.criterionId]),
            ),
            implementationId: "disposable-observation-v1",
          },
        ],
        maxTurns: 8,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  })!;
}

function input(sourceMessageId = "v34-invalidation-message", sourceSequence = 1) {
  return {
    runId: `run-${sourceMessageId}`,
    sessionKey: "v34-invalidation-session",
    sessionId: "v34-invalidation-session-id",
    agentId: "v34-invalidation-agent",
    workspaceId: "v34-invalidation-workspace",
    channel: "v34-invalidation-channel",
    accountId: "v34-invalidation-account",
    principalId: "v34-invalidation-principal",
    conversationId: "v34-invalidation-conversation",
    sourceMessageId,
    sourceSequence,
    prompt: "inspect the fixture",
    now: 100,
  } as const;
}

function admitObservation(scope: GovernorAgentLoopRunScope, key: string, now: number): void {
  const tool = scope.governedTools()[0];
  const decision = scope.beforeTool({
    toolCallId: `observe-${key}`,
    toolName: "observe",
    args: { key },
    tool,
    now,
  });
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("invalidation tool blocked");
  }
  scope.afterTool({
    ticket: decision.ticket,
    toolCallId: `observe-${key}`,
    toolName: "observe",
    result: { key, value: `value-${key}` },
    isError: false,
    now: now + 1,
  });
}

function observe(
  runtime: NonNullable<ReturnType<typeof start>>,
  key: string,
  now: number,
  sourceMessageId = "v34-invalidation-message",
  sourceSequence = 1,
) {
  const scope = resolveGovernorAgentLoopRunScope(input(sourceMessageId, sourceSequence));
  if (!scope) {
    throw new Error("invalidation scope missing");
  }
  admitObservation(scope, key, now);
  return scope;
}

function receipt(
  runtime: NonNullable<ReturnType<typeof start>>,
  evidence: ReturnType<
    NonNullable<ReturnType<typeof start>>["adapter"]["controller"]["store"]["listEvidence"]
  >[number],
  reasonCode: "contradicted_by_newer_evidence" | "freshness_expired",
  observedAt: number,
) {
  const task = runtime.adapter.controller.store.loadTask(evidence.taskId)!;
  return runtime.owners.evidence.submitEvidenceInvalidation({
    scopeKey: task.scopeKey,
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    evidenceId: evidence.evidenceId,
    evidenceDigest: evidence.evidenceDigest,
    reasonCode,
    provenance:
      reasonCode === "freshness_expired"
        ? {
            kind: "freshness_policy" as const,
            freshnessExpiresAt: observedAt - 1,
            policyDigest: "b".repeat(64),
          }
        : {
            kind: "newer_evidence" as const,
            sourceEvidenceId: "v34-newer-evidence",
            sourceEvidenceDigest: "a".repeat(64),
            sourceObservedAt: observedAt - 1,
            sourceScopeKey: task.scopeKey,
            confidence: "high" as const,
            authority: "authenticated_host" as const,
          },
    observedAt,
  });
}

function complete(
  runtime: NonNullable<ReturnType<typeof start>>,
  scope: GovernorAgentLoopRunScope,
) {
  const controller = runtime.adapter.controller;
  controller.beginVerification(scope.taskId as never, 500);
  const result = controller.proposeFinish({
    taskId: scope.taskId as never,
    response: { framing: "summary", materialClaimIds: [] },
    now: 501,
  });
  if (!result.completed) {
    throw new Error("invalidation completion missing");
  }
  const entry = controller.store.outbox.list(scope.taskId as never)[0];
  if (!entry) {
    throw new Error("invalidation outbox missing");
  }
  return {
    taskId: scope.taskId as never,
    effectId: entry.effectId,
    expectedLeaseEpoch: result.task.leaseEpoch,
  };
}

afterEach(() => closeOpenClawStateDatabase());

describe("V34 authenticated evidence invalidation boundary", () => {
  it("rejects unknown, mismatched, and conflicting receipts while accepting freshness provenance", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-invalidation-receipts-" },
      async (state) => {
        const runtime = start(state.stateDir);
        try {
          const scope = observe(runtime, "alpha", 100);
          observe(runtime, "beta", 110);
          const evidence = runtime.adapter.controller.store.listEvidence(scope.taskId as never);
          const alpha = evidence.find((record) => record.criterionId === "alpha")!;
          const beta = evidence.find((record) => record.criterionId === "beta")!;
          const alphaReceipt = receipt(runtime, alpha, "contradicted_by_newer_evidence", 200);
          const secondAlphaReceipt = receipt(runtime, alpha, "contradicted_by_newer_evidence", 201);
          const betaReceipt = receipt(runtime, beta, "freshness_expired", 210);
          const task = runtime.adapter.controller.store.loadTask(scope.taskId as never)!;
          const bindingVariants = [
            { taskId: "wrong-task" },
            { taskVersion: task.taskVersion + 1 },
            { objectiveRevision: task.objectiveRevision + 1 },
            { planVersion: task.planVersion + 1 },
            { evidenceDigest: "c".repeat(64) },
          ] as const;
          for (const [index, variant] of bindingVariants.entries()) {
            const badReceipt = runtime.owners.evidence.submitEvidenceInvalidation({
              scopeKey: task.scopeKey,
              taskId: task.taskId,
              taskVersion: task.taskVersion,
              objectiveRevision: task.objectiveRevision,
              planVersion: task.planVersion,
              evidenceId: alpha.evidenceId,
              evidenceDigest: alpha.evidenceDigest,
              reasonCode: "contradicted_by_newer_evidence",
              provenance: {
                kind: "newer_evidence",
                sourceEvidenceId: `v34-binding-variant-${index}`,
                sourceEvidenceDigest: "a".repeat(64),
                sourceObservedAt: 219,
                sourceScopeKey: task.scopeKey,
                confidence: "high",
                authority: "authenticated_host",
              },
              observedAt: 220,
              ...variant,
            });
            expect(() =>
              runtime.adapter.controller.invalidateEvidence({
                taskId: scope.taskId as never,
                evidenceId: alpha.evidenceId,
                receiptId: badReceipt,
              }),
            ).toThrow("GOVERNOR_EVIDENCE_INVALIDATION_BINDING_INVALID");
            expect(
              runtime.adapter.controller.store
                .listEvidence(scope.taskId as never)
                .find((record) => record.evidenceId === alpha.evidenceId)?.invalidatedAt,
            ).toBeUndefined();
          }
          const wrongScopeReceipt = runtime.owners.evidence.submitEvidenceInvalidation({
            scopeKey: "v34-wrong-scope",
            taskId: task.taskId,
            taskVersion: task.taskVersion,
            objectiveRevision: task.objectiveRevision,
            planVersion: task.planVersion,
            evidenceId: alpha.evidenceId,
            evidenceDigest: alpha.evidenceDigest,
            reasonCode: "contradicted_by_newer_evidence",
            provenance: {
              kind: "newer_evidence",
              sourceEvidenceId: "v34-wrong-scope-source",
              sourceEvidenceDigest: "a".repeat(64),
              sourceObservedAt: 229,
              sourceScopeKey: "v34-wrong-scope",
              confidence: "high",
              authority: "authenticated_host",
            },
            observedAt: 230,
          });
          expect(() =>
            runtime.adapter.controller.invalidateEvidence({
              taskId: scope.taskId as never,
              evidenceId: alpha.evidenceId,
              receiptId: wrongScopeReceipt,
            }),
          ).toThrow("GOVERNOR_EVIDENCE_INVALIDATION_RECEIPT_INVALID");
          expect(
            runtime.adapter.controller.store
              .listEvidence(scope.taskId as never)
              .find((record) => record.evidenceId === alpha.evidenceId)?.invalidatedAt,
          ).toBeUndefined();
          expect(() =>
            runtime.adapter.controller.invalidateEvidence({
              taskId: scope.taskId as never,
              evidenceId: alpha.evidenceId,
              receiptId: "unknown-receipt" as HostGovernorEvidenceInvalidationReceiptId,
            }),
          ).toThrow("GOVERNOR_EVIDENCE_INVALIDATION_RECEIPT_INVALID");
          expect(() =>
            runtime.adapter.controller.invalidateEvidence({
              taskId: scope.taskId as never,
              evidenceId: "wrong-evidence",
              receiptId: alphaReceipt,
            }),
          ).toThrow("GOVERNOR_EVIDENCE_NOT_FOUND");
          expect(() =>
            runtime.adapter.controller.invalidateEvidence({
              taskId: scope.taskId as never,
              evidenceId: beta.evidenceId,
              receiptId: alphaReceipt,
            }),
          ).toThrow("GOVERNOR_EVIDENCE_INVALIDATION_BINDING_INVALID");
          runtime.adapter.controller.invalidateEvidence({
            taskId: scope.taskId as never,
            evidenceId: alpha.evidenceId,
            receiptId: alphaReceipt,
          });
          expect(() =>
            runtime.adapter.controller.invalidateEvidence({
              taskId: scope.taskId as never,
              evidenceId: alpha.evidenceId,
              receiptId: secondAlphaReceipt,
            }),
          ).toThrow("GOVERNOR_EVIDENCE_INVALIDATION_CONFLICT");
          runtime.adapter.controller.invalidateEvidence({
            taskId: scope.taskId as never,
            evidenceId: beta.evidenceId,
            receiptId: betaReceipt,
          });
          expect(
            runtime.adapter.controller.store
              .listEvidence(scope.taskId as never)
              .every((record) => record.invalidatedAt !== undefined),
          ).toBe(true);
        } finally {
          runtime.close();
        }
      },
    );
  });

  it("fences pending delivery and rejects claimed or sent delivery invalidation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v34-invalidation-delivery-" },
      async (state) => {
        for (const mode of ["pending", "claimed", "sent"] as const) {
          const runtime = start(path.join(state.stateDir, mode));
          try {
            const scope = observe(runtime, "alpha", 300, `v34-invalidation-${mode}`, 100);
            admitObservation(scope, "beta", 310);
            const evidence = runtime.adapter.controller.store.listEvidence(
              scope.taskId as never,
            )[0]!;
            const completion = complete(runtime, scope);
            if (mode === "claimed") {
              const adapter = runtime.adapter.controller.store.resolveCertifiedDelivery(
                runtime.deliveryHandles[0],
              );
              const binding = {
                adapterHandle: adapter.handle,
                identityKey: adapter.identityKey,
                implementationDigest: adapter.implementationDigest,
                configDigest: adapter.configDigest,
                generation: adapter.generation,
                channel: adapter.binding.channel,
                accountIdentity: adapter.binding.accountIdentity,
                targetIdentity: adapter.binding.targetIdentity,
                deploymentIdentity: adapter.binding.deploymentIdentity,
              };
              const claim = runtime.adapter.controller.store.outbox.claim({
                ...completion,
                workerId: "invalidation-claimed-worker",
                now: 510,
                deliveryBinding: binding,
              });
              expect(claim.kind).toBe("claimed");
            } else if (mode === "sent") {
              await runtime.adapter.controller.dispatchOutbox({
                ...completion,
                workerId: "invalidation-sent-worker",
                adapterHandle: runtime.deliveryHandles[0],
                now: 520,
              });
            }
            const invalidation = receipt(runtime, evidence, "contradicted_by_newer_evidence", 600);
            if (mode === "pending") {
              runtime.adapter.controller.invalidateEvidence({
                taskId: scope.taskId as never,
                evidenceId: evidence.evidenceId,
                receiptId: invalidation,
              });
              expect(
                runtime.adapter.controller.store
                  .listEvidence(scope.taskId as never)
                  .find((record) => record.evidenceId === evidence.evidenceId)?.invalidatedAt,
              ).toBe(600);
              expect(
                runtime.adapter.controller.store.outbox.list(scope.taskId as never)[0]?.state,
              ).toBe("manual_review");
            } else {
              expect(() =>
                runtime.adapter.controller.invalidateEvidence({
                  taskId: scope.taskId as never,
                  evidenceId: evidence.evidenceId,
                  receiptId: invalidation,
                }),
              ).toThrow(
                mode === "claimed"
                  ? "GOVERNOR_EVIDENCE_INVALIDATION_DELIVERY_IN_FLIGHT"
                  : "GOVERNOR_EVIDENCE_INVALIDATION_AFTER_DELIVERY",
              );
              expect(
                runtime.adapter.controller.store
                  .listEvidence(scope.taskId as never)
                  .find((record) => record.evidenceId === evidence.evidenceId)?.invalidatedAt,
              ).toBeUndefined();
              expect(
                runtime.adapter.controller.store.outbox.list(scope.taskId as never)[0]?.state,
              ).toBe(mode);
            }
          } finally {
            runtime.close();
            closeOpenClawStateDatabase();
          }
        }
      },
    );
  });
});
