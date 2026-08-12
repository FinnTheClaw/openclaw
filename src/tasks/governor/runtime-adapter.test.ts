// Proves the integration seam is inert while disabled and proportional when explicitly enabled.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGovernorHostRuntimeAdapterIfEnabled,
  createGovernorHostRuntimeIfEnabled,
} from "../../security/governor-host-bootstrap.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorController } from "./controller.js";
import { GovernorSqliteStore } from "./store.js";
import type { GovernorTaskContract, GovernorTaskScope } from "./types.js";

const scope: GovernorTaskScope = {
  principalId: "principal-runtime",
  channel: "synthetic",
  accountId: "account-runtime",
  conversationId: "conversation-runtime",
  sessionId: "session-runtime",
  agentId: "agent-runtime",
  workspaceId: "workspace-runtime",
};

const contract: GovernorTaskContract = {
  objective: "Inspect a synthetic runtime",
  constraints: [],
  knownFacts: [],
  unknowns: ["state"],
  completionCriteria: [
    { criterionId: "verified", description: "State is verified", mandatory: true },
  ],
  authority: { allowReadOnlyDiscovery: true, mutationCapabilities: [], canonicalTargets: [] },
};

const quickContract: GovernorTaskContract = {
  objective: "Answer a prompt-contained synthetic question",
  constraints: [],
  knownFacts: ["The answer is present in the prompt"],
  unknowns: [],
  completionCriteria: [],
  authority: { allowReadOnlyDiscovery: false, mutationCapabilities: [], canonicalTargets: [] },
};

const integrations = {
  evidenceOwnerId: "synthetic-evidence-owner",
  approvalOwnerId: "synthetic-approval-owner",
  deliveryOwnerId: "synthetic-delivery-owner",
  ownerIngressOwnerId: "synthetic-owner-ingress",
  childOwnerId: "synthetic-child-owner",
  ownerIngressBindings: [
    {
      channel: "signal",
      accountId: "owner-account-fixture",
      gatewayInstanceId: "owner-gateway-fixture",
      ownerPrincipal: "owner-principal-fixture",
      actions: ["reinvestigate", "repair"],
      scopeKeys: ["owner-scope-fixture"],
    },
  ],
  deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
} as const;

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "synthetic-host-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "synthetic-host-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "synthetic-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "synthetic-host-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "synthetic-host-ledger-key",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "synthetic-host-deployment",
  };
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor runtime adapter", () => {
  it("creates no state and changes no behavior while the feature flag is off", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-runtime-off-" },
      async (state) => {
        const before = fs.readdirSync(state.stateDir).toSorted();
        expect(
          createGovernorHostRuntimeAdapterIfEnabled({
            env: { OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "0" },
            stateDir: state.stateDir,
            capabilities: [],
          }),
        ).toBeNull();
        expect(fs.readdirSync(state.stateDir).toSorted()).toEqual(before);
      },
    );
  });

  it("does not create governor objects when the ordinary shared database opens", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-schema-off-" },
      async (state) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: state.stateDir };
        const database = openOpenClawStateDatabase({ env });
        const before = database.db
          .prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'governor_%'")
          .all();
        expect(before).toEqual([]);
        closeOpenClawStateDatabase();
        const enabledStore = new GovernorSqliteStore({ stateDir: state.stateDir });
        expect(enabledStore).toBeInstanceOf(GovernorSqliteStore);
        const after = openOpenClawStateDatabase({ env })
          .db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'governor_%'")
          .all();
        expect(after.length).toBeGreaterThan(0);
        closeOpenClawStateDatabase();
      },
    );
  });

  it("persists only keyed opaque identity references", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-opaque-identities-" },
      async (state) => {
        const store = new GovernorSqliteStore({ stateDir: state.stateDir });
        const controller = new GovernorController(store, store.capabilities);
        try {
          const privateScope = {
            ...scope,
            principalId: "principal-fixture-alpha",
            accountId: "account-fixture-beta",
            conversationId: "conversation-fixture-gamma",
          };
          const task = controller.ingest({
            sourceMessageId: "message-fixture-delta",
            sourceSequence: 1,
            scope: privateScope,
            mode: "FOCUSED",
            contract,
            now: 100,
          }).task;
          controller.recordContradiction({
            taskId: task.taskId,
            contradiction: {
              contradictionId: "private-source",
              detail: "synthetic contradiction",
              severity: "high",
              sourceRef: "fixture-contradiction-epsilon",
              observedAt: 101,
            },
            now: 101,
          });
          const raw = JSON.stringify({
            task: store.loadTask(task.taskId),
            events: store.listEvents(task.taskId),
          });
          for (const privateValue of [
            "principal-fixture-alpha",
            "account-fixture-beta",
            "conversation-fixture-gamma",
            "message-fixture-delta",
          ]) {
            expect(raw).not.toContain(privateValue);
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("keeps quick chat direct and attaches consequential ingress to its existing flow", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-runtime-on-" },
      async (state) => {
        try {
          const adapter = createGovernorHostRuntimeAdapterIfEnabled({
            env: enabledEnvironment(),
            stateDir: state.stateDir,
            capabilities: [],
            integrations,
          });
          if (!adapter) {
            throw new Error("expected enabled governor adapter");
          }
          expect(
            adapter.routeIngress({
              sourceMessageId: "quick-1",
              sourceSequence: 1,
              scope,
              profile: {
                incident: false,
                effectful: false,
                requiresExternalEvidence: false,
                consequential: false,
                estimatedUsefulActions: 0,
                independentBranches: 0,
              },
              contract: quickContract,
              now: 100,
            }),
          ).toMatchObject({
            kind: "quick",
            decision: { mode: "QUICK", toolPolicy: "forbidden" },
          });
          const governed = adapter.routeIngress({
            sourceMessageId: "focused-1",
            sourceSequence: 2,
            scope,
            profile: {
              incident: false,
              effectful: false,
              requiresExternalEvidence: true,
              consequential: true,
              estimatedUsefulActions: 3,
              independentBranches: 1,
            },
            contract,
            flowId: "flow-existing-1",
            now: 101,
          });
          expect(governed).toMatchObject({
            kind: "governed",
            decision: { mode: "FOCUSED", toolPolicy: "required" },
            task: { state: "RECEIVED" },
          });
          if (governed.kind !== "governed") {
            throw new Error("expected governed runtime route");
          }
          expect(governed.task.flowId).toMatch(/^[a-f0-9]{64}$/u);
          expect(governed.task.flowId).not.toBe("flow-existing-1");
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it("fails enabled initialization without the host identity key", () => {
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: {
          ...enabledEnvironment(),
          OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "",
        },
        capabilities: [],
        integrations,
      }),
    ).toThrow(/IDENTITY_HMAC_KEY is required/u);
  });

  it("fails enabled initialization without the host receipt key", () => {
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: {
          ...enabledEnvironment(),
          OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "",
        },
        capabilities: [],
        integrations,
      }),
    ).toThrow(/HOST_RECEIPT_HMAC_KEY is required/u);
  });

  it("fails enabled initialization without integration owners or a delivery", () => {
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
      }),
    ).toThrow(/integration owners are required/u);
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
        integrations: { ...integrations, deliveries: [] },
      }),
    ).toThrow(/At least one certified governor delivery integration/u);
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
        integrations: { ...integrations, approvalOwnerId: "" },
      }),
    ).toThrow(/approval integration owner is required/u);
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
        integrations: { ...integrations, ownerIngressOwnerId: "" },
      }),
    ).toThrow(/owner ingress integration owner is required/u);
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
        integrations: { ...integrations, childOwnerId: "" },
      }),
    ).toThrow(/child lifecycle integration owner is required/u);
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env: enabledEnvironment(),
        capabilities: [],
        integrations: { ...integrations, ownerIngressBindings: [] },
      }),
    ).toThrow(/authenticated governor owner binding is required/u);
  });

  it("uses only supplied secrets and returns separated host integration owners", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-explicit-secrets-" },
      async (state) => {
        const names = [
          "NODE_ENV",
          "OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY",
          "OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY",
          "OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY",
          "OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY",
          "OPENCLAW_GOVERNOR_DEPLOYMENT_ID",
        ] as const;
        const prior = new Map(names.map((name) => [name, process.env[name]]));
        for (const name of names) {
          delete process.env[name];
        }
        try {
          const runtime = createGovernorHostRuntimeIfEnabled({
            env: enabledEnvironment(),
            stateDir: state.stateDir,
            capabilities: [],
            integrations,
          });
          expect(runtime?.deliveryHandles).toHaveLength(1);
          expect(runtime?.owners).toMatchObject({
            evidence: { ownerId: integrations.evidenceOwnerId },
            approval: { ownerId: integrations.approvalOwnerId },
            delivery: { ownerId: integrations.deliveryOwnerId },
            ownerIngress: { ownerId: integrations.ownerIngressOwnerId },
            child: { ownerId: integrations.childOwnerId },
          });
          expect(() =>
            runtime?.owners.child.submitLifecycleReceipt({
              scopeKey: "synthetic-scope",
              taskId: "synthetic-task",
              taskVersion: 0,
              objectiveRevision: 1,
              planVersion: 0,
              sourceKind: "structured_external",
              sourceIdentity: "synthetic-source",
              payload: { kind: "unrelated_observation" },
              observedAt: 1,
            }),
          ).toThrow(/only child lifecycle observations/u);
          expect(runtime?.adapter).toBeInstanceOf(Object);
        } finally {
          for (const [name, value] of prior) {
            if (value === undefined) {
              delete process.env[name];
            } else {
              process.env[name] = value;
            }
          }
        }
      },
    );
  });

  it("orders authenticated owner envelopes by provider sequence without trusting prose", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-owner-ingress-" },
      async (state) => {
        const runtime = createGovernorHostRuntimeIfEnabled({
          env: enabledEnvironment(),
          stateDir: state.stateDir,
          capabilities: [],
          integrations,
        });
        if (!runtime) {
          throw new Error("expected enabled governor runtime");
        }
        const common = {
          accountId: "owner-account-fixture",
          gatewayInstanceId: "owner-gateway-fixture",
          ownerPrincipal: "owner-principal-fixture",
          scopeKey: "owner-scope-fixture",
          observedAt: 100,
          expiresAt: 300,
        } as const;
        const revisionTwo = runtime.owners.ownerIngress.submitSignal({
          ...common,
          transportEventId: "owner-event-two",
          sourceSequence: 2,
          action: "reinvestigate",
          nonce: "owner-nonce-two",
        });
        const revisionOne = runtime.owners.ownerIngress.submitSignal({
          ...common,
          transportEventId: "owner-event-one",
          sourceSequence: 1,
          action: "repair",
          nonce: "owner-nonce-one",
        });
        const newest = runtime.adapter.routeAuthenticatedOwnerIngress({
          receiptId: revisionTwo,
          now: 150,
        });
        expect(() =>
          runtime.adapter.routeAuthenticatedOwnerIngress({
            receiptId: revisionOne,
            now: 151,
          }),
        ).toThrow(/invalid, expired, or mismatched/u);
        expect(() =>
          runtime.adapter.routeAuthenticatedOwnerIngress({
            receiptId: revisionTwo,
            now: 152,
          }),
        ).toThrow(/invalid, expired, or mismatched/u);
        expect(newest.kind).toBe("governed");
        if (newest.kind !== "governed") {
          throw new Error("expected governed owner ingress");
        }
        expect(newest.task.authenticatedSourceSequence).toBe(2);
        expect(newest.task.contract.objective).toContain("reinvestigate");

        const db = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        }).db;
        expect(db.prepare("SELECT COUNT(*) AS count FROM governor_tasks").get()).toEqual({
          count: 1,
        });
        const durable = JSON.stringify(
          db.prepare("SELECT * FROM governor_owner_ingress_receipts").all(),
        );
        for (const raw of [
          "owner-account-fixture",
          "owner-gateway-fixture",
          "owner-principal-fixture",
          "owner-event-one",
          "owner-event-two",
          "owner-scope-fixture",
        ]) {
          expect(durable).not.toContain(raw);
        }

        closeOpenClawStateDatabase();
        const restarted = createGovernorHostRuntimeIfEnabled({
          env: enabledEnvironment(),
          stateDir: state.stateDir,
          capabilities: [],
          integrations,
        });
        expect(() =>
          restarted?.adapter.routeAuthenticatedOwnerIngress({
            receiptId: revisionTwo,
            now: 153,
          }),
        ).toThrow(/invalid, expired, or mismatched/u);
      },
    );
  });

  it("rejects reused bootstrap keys instead of constructing mismatched lower layers", () => {
    const env = enabledEnvironment();
    env.OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY = env.OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY;
    expect(() =>
      createGovernorHostRuntimeAdapterIfEnabled({
        env,
        capabilities: [],
        integrations,
      }),
    ).toThrow(/independently provisioned/u);
  });
});
