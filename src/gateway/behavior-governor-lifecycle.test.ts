import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveBehaviorGovernorBootDecision } from "../config/behavior-governor-boot-decision.js";
import type { BehaviorGovernorConfig } from "../config/types.behavior-governor.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBehaviorGovernorLifecycle } from "./behavior-governor-lifecycle.js";

const refs = {
  identityHmacKey: { source: "env", provider: "default", id: "GOV_IDENTITY" },
  evidenceAdmissionKey: { source: "env", provider: "default", id: "GOV_EVIDENCE" },
  receiptSigningKey: { source: "env", provider: "default", id: "GOV_RECEIPT" },
  ledgerSigningKey: { source: "env", provider: "default", id: "GOV_LEDGER" },
  deploymentIdentity: { source: "env", provider: "default", id: "GOV_DEPLOYMENT" },
} as const;

const sourceGovernor = {
  enabled: true,
  mode: "shadow" as const,
  secretRefs: refs,
  agentLoop: {
    scopes: [{ sessionKey: "fixture" }],
    criteria: [],
    toolBindings: [],
    maxTurns: 3,
  },
} satisfies Extract<BehaviorGovernorConfig, { enabled: true }>;

const resolvedGovernor = {
  ...sourceGovernor,
  secretRefs: {
    identityHmacKey: "resolved-identity-secret",
    evidenceAdmissionKey: "resolved-evidence-secret",
    receiptSigningKey: "resolved-receipt-secret",
    ledgerSigningKey: "resolved-ledger-secret",
    deploymentIdentity: "resolved-deployment-secret",
    evidenceAdmissionKeyId: "prepared-v1",
  },
};

const capability: GovernorCapabilityDefinition = {
  capability: "fixture.lifecycle",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function integrations(deliveries = true) {
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
    deliveries: deliveries
      ? [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }]
      : [],
  };
}

function decisionFor(governor: Extract<BehaviorGovernorConfig, { enabled: true }>) {
  return deriveBehaviorGovernorBootDecision({
    experimental: { behaviorGovernor: governor },
  });
}

function snapshotFor(stateDir: string, sourceConfig = sourceGovernor) {
  return {
    sourceConfig,
    config: { secretRefs: { ...resolvedGovernor.secretRefs } },
    env: { NODE_ENV: "test", OPENCLAW_STATE_DIR: stateDir },
    generation: "prepared-generation-1",
  };
}

describe("gateway behavior governor prepared snapshot binding", () => {
  it("passes only cloned policy and prepared governor secrets to the factory", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-lifecycle-snapshot-" },
      async (state) => {
        const stateDir = state.stateDir;
        let received:
          | {
              config: Record<string, unknown>;
              secrets: Record<string, unknown>;
              stateDir: string;
            }
          | undefined;
        const lifecycle = createGatewayBehaviorGovernorLifecycle({
          bootDecision: decisionFor(sourceGovernor),
          hostFactory: async (input) => {
            received = {
              config: input.config as unknown as Record<string, unknown>,
              secrets: input.secrets as unknown as Record<string, unknown>,
              stateDir: input.stateDir,
            };
            expect(() => {
              (input.config.agentLoop as { maxTurns: number }).maxTurns = 99;
            }).toThrow();
            expect(() => {
              (input.secrets as { identityHmacKey: string }).identityHmacKey = "changed";
            }).toThrow();
            throw new Error("fixture factory stop");
          },
        });
        await expect(
          lifecycle.apply({
            sourceConfig: sourceGovernor,
            config: { secretRefs: resolvedGovernor.secretRefs },
            env: { NODE_ENV: "test", OPENCLAW_STATE_DIR: stateDir },
            generation: "prepared-generation-1",
          }),
        ).rejects.toThrow("fixture factory stop");
        expect(received?.stateDir).toBe(path.join(stateDir, "governor"));
        expect(received?.config).toEqual({
          enabled: true,
          mode: "shadow",
          agentLoop: sourceGovernor.agentLoop,
        });
        expect(received?.secrets).toEqual({
          identityHmacKey: "resolved-identity-secret",
          evidenceAdmissionKey: "resolved-evidence-secret",
          receiptSigningKey: "resolved-receipt-secret",
          ledgerSigningKey: "resolved-ledger-secret",
          deploymentIdentity: "resolved-deployment-secret",
          evidenceAdmissionKeyId: "prepared-v1",
        });
        expect(JSON.stringify(received)).not.toContain("unrelated");
        expect(fs.existsSync(path.join(stateDir, "governor"))).toBe(false);
      },
    );
  });

  it("keeps OFF inert and owns one immutable generation until restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-lifecycle-active-" },
      async (state) => {
        let factoryCalls = 0;
        const offLifecycle = createGatewayBehaviorGovernorLifecycle({
          bootDecision: deriveBehaviorGovernorBootDecision({}),
          hostFactory: () => {
            factoryCalls += 1;
            return { capabilities: [capability], integrations: integrations() };
          },
        });
        await offLifecycle.apply(snapshotFor(state.stateDir));
        expect(factoryCalls).toBe(0);
        expect(fs.existsSync(path.join(state.stateDir, "governor"))).toBe(false);

        const lifecycle = createGatewayBehaviorGovernorLifecycle({
          bootDecision: decisionFor(sourceGovernor),
          hostFactory: () => {
            factoryCalls += 1;
            return { capabilities: [capability], integrations: integrations() };
          },
        });
        await lifecycle.apply(snapshotFor(state.stateDir));
        await lifecycle.apply(snapshotFor(state.stateDir));
        expect(factoryCalls).toBe(1);
        expect(fs.existsSync(path.join(state.stateDir, "governor"))).toBe(true);

        const changedSource = {
          ...sourceGovernor,
          agentLoop: { ...sourceGovernor.agentLoop, maxTurns: 4 },
        } as typeof sourceGovernor;
        await expect(
          lifecycle.apply(snapshotFor(state.stateDir, changedSource)),
        ).rejects.toThrow("GOVERNOR_GATEWAY_RESTART_REQUIRED");
        await lifecycle.close();
        expect(fs.existsSync(path.join(state.stateDir, "governor"))).toBe(true);
      },
    );
  });

  it.each([
    ["plaintext", { ...sourceGovernor, secretRefs: { ...refs, identityHmacKey: "plain" } }],
    ["missing snapshot value", sourceGovernor],
  ] as const)("fails closed for %s secret input before allocation", async (label, source) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: `governor-lifecycle-${label.replaceAll(" ", "-")}-` },
      async (state) => {
        const lifecycle = createGatewayBehaviorGovernorLifecycle({
          bootDecision: decisionFor(source as typeof sourceGovernor),
          hostFactory: () => {
            throw new Error("factory must not run");
          },
        });
        const snapshot = snapshotFor(state.stateDir, source as typeof sourceGovernor);
        if (label === "missing snapshot value") {
          snapshot.config.secretRefs.identityHmacKey = "";
        }
        await expect(
          lifecycle.apply(snapshot),
        ).rejects.toThrow(
          label === "plaintext"
            ? "GOVERNOR_GATEWAY_SECRET_REF_INVALID"
            : "GOVERNOR_GATEWAY_SECRET_SNAPSHOT_INCOMPLETE",
        );
        expect(fs.existsSync(path.join(state.stateDir, "governor"))).toBe(false);
      },
    );
  });

  it("aggregates startup and close cleanup failures without leaking the state directory", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-lifecycle-cleanup-" },
      async (state) => {
        let startupCloseCalls = 0;
        const startupFailure = createGatewayBehaviorGovernorLifecycle({
          bootDecision: decisionFor(sourceGovernor),
          hostFactory: () => ({
            capabilities: [capability],
            integrations: integrations(false),
            close: () => {
              startupCloseCalls += 1;
              throw new Error("factory startup cleanup failed");
            },
          }),
        });
        await expect(
          startupFailure.apply(snapshotFor(state.stateDir)),
        ).rejects.toBeInstanceOf(AggregateError);
        expect(startupCloseCalls).toBe(1);
        expect(fs.existsSync(path.join(state.stateDir, "governor"))).toBe(false);

        let closeCalls = 0;
        const closeFailure = createGatewayBehaviorGovernorLifecycle({
          bootDecision: decisionFor(sourceGovernor),
          hostFactory: () => ({
            capabilities: [capability],
            integrations: integrations(),
            close: () => {
              closeCalls += 1;
              throw new Error("factory close failed");
            },
          }),
        });
        await closeFailure.apply(snapshotFor(state.stateDir));
        await expect(closeFailure.close()).rejects.toBeInstanceOf(AggregateError);
        await expect(closeFailure.close()).rejects.toBeInstanceOf(AggregateError);
        expect(closeCalls).toBe(1);
      },
    );
  });
});
