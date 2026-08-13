import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createGovernorHostRuntimeBindings,
  createGovernorHostRuntimeIfEnabled,
} from "./governor-host-bootstrap.js";
import { isTrustedGovernorMemoryAuthority } from "./governor-host-memory-authority.js";
import { isTrustedGovernorPhysicalExecutionCoordinator } from "./governor-host-physical-execution.js";
import { isTrustedGovernorTaskAuthority } from "./governor-host-task-authority.js";

const env = (stateDir: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "lifecycle-identity",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "lifecycle-evidence",
  OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "lifecycle-evidence-v1",
  OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "lifecycle-receipt",
  OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "lifecycle-ledger",
  OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "lifecycle-deployment",
});

function integrations() {
  return {
    evidenceOwnerId: "lifecycle-evidence-owner",
    approvalOwnerId: "lifecycle-approval-owner",
    deliveryOwnerId: "lifecycle-delivery-owner",
    ownerIngressOwnerId: "lifecycle-ingress-owner",
    childOwnerId: "lifecycle-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "lifecycle-account",
        gatewayInstanceId: "lifecycle-gateway",
        ownerPrincipal: "lifecycle-owner",
        actions: ["repair" as const],
        scopeKeys: ["lifecycle-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
  } as const;
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor host lifecycle ownership", () => {
  it("preserves trusted brands and revokes retained capabilities before database close", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-lifecycle-close-" },
      async (state) => {
        const runtimeEnv = env(state.stateDir);
        const databasePath = resolveOpenClawStateSqlitePath(runtimeEnv);
        const databaseArtifacts = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
        const runtime = createGovernorHostRuntimeBindings({
          env: runtimeEnv,
          stateDir: state.stateDir,
          integrations: integrations(),
        });
        const beforeArtifacts = databaseArtifacts.map((file) =>
          fs.existsSync(file) ? fs.statSync(file).size : null,
        );
        expect(isTrustedGovernorMemoryAuthority(runtime.memoryAuthority)).toBe(true);
        expect(isTrustedGovernorTaskAuthority(runtime.taskAuthority)).toBe(true);
        expect(
          isTrustedGovernorPhysicalExecutionCoordinator(runtime.physicalExecutionCoordinator),
        ).toBe(true);
        expect(isOpenClawStateDatabaseOpen()).toBe(true);
        runtime.close();
        runtime.close();
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
        expect(() => runtime.memoryAuthority.state("lifecycle-scope", "fact")).toThrow(
          "GOVERNOR_HOST_CAPABILITY_CLOSED",
        );
        expect(() => runtime.taskAuthority.state("task")).toThrow(
          "GOVERNOR_HOST_CAPABILITY_CLOSED",
        );
        expect(() => runtime.physicalExecutionCoordinator.state(0)).toThrow(
          "GOVERNOR_HOST_CAPABILITY_CLOSED",
        );
        const closedArtifacts = databaseArtifacts.map((file) =>
          fs.existsSync(file) ? fs.statSync(file).size : null,
        );
        expect(closedArtifacts[0]).toBeGreaterThanOrEqual(beforeArtifacts[0] ?? 0);
        expect(closedArtifacts.slice(1)).toEqual([null, null]);
        const retainedCalls = [
          () => runtime.owners.evidence.submitObservedReceipt({} as never),
          () => runtime.owners.evidence.submitEvidenceInvalidation({} as never),
          () => runtime.owners.approval.submitAuthenticatedApproval({} as never),
          () => runtime.owners.approval.submitApprovalRevocation({} as never),
          () => runtime.owners.delivery.registerStaticDeliveryAdapter({} as never),
          () => runtime.owners.delivery.revokeDeliveryAdapter({} as never),
          () => runtime.owners.delivery.resolveUnknownDelivery({} as never),
          () => runtime.owners.ownerIngress.revokeReceipt({} as never),
          () =>
            runtime.owners.child.submitLifecycleReceipt({
              scopeKey: "lifecycle-scope",
              taskId: "task",
              taskVersion: 0,
              objectiveRevision: 0,
              planVersion: 0,
              sourceKind: "structured_external",
              sourceIdentity: "opaque-source",
              payload: { kind: "governor_external_child_terminal" },
              observedAt: 1,
            }),
          () => runtime.resolver.resolve("ghr_closed" as never, "scope"),
          () =>
            runtime.evidenceInvalidationResolver.resolveEvidenceInvalidation(
              "ghr_closed" as never,
              "scope",
            ),
          () => runtime.approvalResolver.resolveApproval("ghr_closed" as never, "scope"),
          () => runtime.ownerIngressResolver.claim("ghr_closed" as never, 1),
        ];
        for (const call of retainedCalls) {
          expect(call).toThrow("GOVERNOR_HOST_CAPABILITY_CLOSED");
        }
        expect(runtime.deliveryResolver.resolve("ghr_closed" as never)).toBeNull();
        expect(
          databaseArtifacts.map((file) => (fs.existsSync(file) ? fs.statSync(file).size : null)),
        ).toEqual(closedArtifacts);
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
        expect(path.dirname(databasePath)).toContain(path.resolve(state.stateDir));
      },
    );
  });

  it("fences retained runtime, controller, and adapter calls without reopening the database", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-lifecycle-fence-" },
      async (state) => {
        const runtimeEnv = env(state.stateDir);
        const capability = {
          capability: "fixture.lifecycle.observe",
          version: "1",
          sourceRank: "structured_exact" as const,
          mutating: false,
          canonicalTargetPrefixes: ["fixture:"],
          requiresApproval: false,
        };
        const runtime = createGovernorHostRuntimeIfEnabled({
          enabled: true,
          env: runtimeEnv,
          stateDir: state.stateDir,
          capabilities: [capability],
          integrations: integrations(),
        });
        if (!runtime) {
          throw new Error("expected lifecycle fixture runtime");
        }
        const databasePath = resolveOpenClawStateSqlitePath(runtimeEnv);
        const databaseArtifacts = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
        runtime.close();
        const closedArtifacts = databaseArtifacts.map((file) =>
          fs.existsSync(file) ? fs.statSync(file).size : null,
        );
        const scope = {
          principalId: "principal",
          channel: "fixture",
          accountId: "account",
          conversationId: "conversation",
          sessionId: "session",
          agentId: "agent",
          workspaceId: "workspace",
        };
        const contract = {
          objective: "Observe one fixture fact",
          constraints: [],
          knownFacts: [],
          unknowns: ["fixture fact"],
          completionCriteria: [
            { criterionId: "fact", description: "fixture fact", mandatory: true },
          ],
          authority: {
            allowReadOnlyDiscovery: true,
            mutationCapabilities: [],
            canonicalTargets: ["fixture:observe"],
          },
        };
        const profile = {
          incident: false,
          effectful: true,
          requiresExternalEvidence: true,
          consequential: false,
          estimatedUsefulActions: 1,
          independentBranches: 0,
        };
        const retainedCalls = [
          () =>
            runtime.adapter.routeIngress({
              sourceMessageId: "closed-source",
              sourceSequence: 1,
              scope,
              profile,
              contract,
              now: 1,
            }),
          () =>
            runtime.adapter.controller.ingest({
              sourceMessageId: "closed-controller-source",
              sourceSequence: 2,
              scope,
              profile,
              contract,
              now: 2,
            }),
          () => runtime.adapter.controller.store.loadTask("closed-task" as never),
          () =>
            runtime.adapter.routeAuthenticatedOwnerIngress({
              receiptId: "ghr_closed" as never,
              now: 3,
            }),
        ];
        for (const call of retainedCalls) {
          expect(call).toThrow("GOVERNOR_HOST_CAPABILITY_CLOSED");
        }
        expect(
          databaseArtifacts.map((file) => (fs.existsSync(file) ? fs.statSync(file).size : null)),
        ).toEqual(closedArtifacts);
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
      },
    );
  });

  it("closes partially registered delivery state and reconstructs the same generation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-lifecycle-delivery-" },
      async (state) => {
        const runtimeEnv = env(state.stateDir);
        const first = createGovernorHostRuntimeIfEnabled({
          enabled: true,
          env: runtimeEnv,
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integrations(),
        });
        if (!first) {
          throw new Error("expected first runtime");
        }
        const handle = first.deliveryHandles[0];
        first.close();
        const second = createGovernorHostRuntimeIfEnabled({
          enabled: true,
          env: runtimeEnv,
          stateDir: state.stateDir,
          capabilities: [],
          integrations: integrations(),
        });
        if (!second) {
          throw new Error("expected reconstructed runtime");
        }
        expect(second.deliveryHandles[0]).toBe(handle);
        expect(second.adapter.controller.store.resolveCertifiedDelivery(handle)).not.toBeNull();
        second.close();

        const broken = {
          ...integrations(),
          deliveries: [
            ...integrations().deliveries,
            { implementationId: "caller-owned", config: {}, generation: 0 },
          ],
        };
        expect(() =>
          createGovernorHostRuntimeBindings({
            env: runtimeEnv,
            stateDir: state.stateDir,
            integrations: broken,
          }),
        ).toThrow(/not allowlisted/u);
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
      },
    );
  });

  it("retains the startup error and persistence cleanup error after partial allocation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-host-lifecycle-errors-" },
      async (state) => {
        const runtimeEnv = env(state.stateDir);
        const brokerError = new Error("fixture broker construction failed");
        const persistenceError = new Error("fixture persistence close failed");
        let thrown: unknown;
        try {
          createGovernorHostRuntimeBindings({
            env: runtimeEnv,
            stateDir: state.stateDir,
            integrations: integrations(),
            testMode: true,
            testAfterPersistenceCreated: () => {
              throw brokerError;
            },
            testPersistenceClose: () => {
              throw persistenceError;
            },
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AggregateError);
        const aggregate = thrown as AggregateError;
        expect(aggregate.errors[0]).toBe(brokerError);
        expect((aggregate.errors[1] as AggregateError).errors).toContain(persistenceError);
        expect(isOpenClawStateDatabaseOpen()).toBe(false);

        const partialPersistenceError = new Error("fixture partial persistence close failed");
        const broken = {
          ...integrations(),
          deliveries: [
            ...integrations().deliveries,
            { implementationId: "caller-owned", config: {}, generation: 0 },
          ],
        };
        let partialThrown: unknown;
        try {
          createGovernorHostRuntimeBindings({
            env: runtimeEnv,
            stateDir: state.stateDir,
            integrations: broken,
            testMode: true,
            testPersistenceClose: () => {
              throw partialPersistenceError;
            },
          });
        } catch (error) {
          partialThrown = error;
        }
        expect(partialThrown).toBeInstanceOf(AggregateError);
        const partialAggregate = partialThrown as AggregateError;
        expect(String(partialAggregate.errors[0])).toContain("not allowlisted");
        expect((partialAggregate.errors[1] as AggregateError).errors).toContain(
          partialPersistenceError,
        );
        expect(isOpenClawStateDatabaseOpen()).toBe(false);
      },
    );
  });
});
