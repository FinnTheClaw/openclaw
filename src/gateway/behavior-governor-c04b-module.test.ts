import { afterEach, describe, expect, it, vi } from "vitest";
import { createGovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-types.js";
import {
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostRuntime,
} from "../security/governor-host-bootstrap.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { C04B_AGGREGATE_ORDER_MODULE } from "./behavior-governor-c04b-module.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { BUILT_IN_BEHAVIOR_GOVERNOR_MODULES } from "./behavior-governor-module-plan.js";
import { createGatewayBehaviorGovernorModuleRunBindingAuthority } from "./behavior-governor-module-run-bindings.js";

const activation = Object.freeze({
  id: "c04b-aggregate-order",
  mode: "enforce" as const,
  version: "v1",
});

const capabilities = Object.freeze([
  {
    capability: "c04b.observe",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c04b/observations"],
    requiresApproval: false,
  },
  {
    capability: "c04b.aggregate",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c04b/aggregate"],
    requiresApproval: false,
  },
]);

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c04b-identity-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c04b-evidence-key-long",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c04b-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c04b-receipt-key-long",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c04b-ledger-key-long",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c04b-deployment-long",
    INVOCATION_ID: "c04b-test-invocation",
  };
}

function runtime(stateDir: string): GovernorHostRuntime {
  const created = createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: environment(),
    stateDir,
    capabilities,
    integrations: {
      evidenceOwnerId: "c04b-evidence-owner",
      approvalOwnerId: "c04b-approval-owner",
      deliveryOwnerId: "c04b-delivery-owner",
      ownerIngressOwnerId: "c04b-ingress-owner",
      childOwnerId: "c04b-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c04b-owner-account",
          gatewayInstanceId: "c04b-owner-gateway",
          ownerPrincipal: "c04b-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c04b-owner-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
    },
  });
  if (!created) {
    throw new Error("C04B runtime unavailable");
  }
  return created;
}

function run(): GovernorAgentLoopRunInput {
  return {
    runId: "c04b-run",
    sessionKey: "c04b-session-key",
    sessionId: "c04b-session",
    agentId: "c04b-agent",
    workspaceId: "c04b-workspace",
    channel: "c04b-channel",
    accountId: "c04b-account",
    principalId: "c04b-principal",
    conversationId: "c04b-conversation",
    sourceMessageId: "c04b-message",
    sourceSequence: 1,
    prompt: "run exact c04b campaign",
    now: 100,
  };
}

async function scope(host: GovernorHostRuntime): Promise<{
  close: () => void;
  scope: GovernorAgentLoopRunScope;
}> {
  const create = await C04B_AGGREGATE_ORDER_MODULE.load();
  const module = await create({
    ...activation,
    host: {
      agentLoop: {
        createScopeProvider(config) {
          const provider = createGovernorAgentLoopScopeProvider({
            controller: host.adapter.controller,
            submitObservedReceipt: host.owners.evidence.submitObservedReceipt,
            capabilities,
            config,
          });
          const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({
            activation,
            provider,
          });
          return authority;
        },
      },
    },
  });
  const resolved = module.agentLoop?.resolveRunScope({ activation, run: run() });
  if (!resolved) {
    module.close();
    throw new Error("C04B scope unavailable");
  }
  return { close: module.close, scope: resolved };
}

async function observe(
  target: GovernorAgentLoopRunScope,
  label: string,
  index: number,
): Promise<void> {
  const tool = target.governedTools().find((candidate) => candidate.name === "observe");
  if (!tool) {
    throw new Error("C04B observe tool unavailable");
  }
  const now = 200 + index * 10;
  const decision = target.beforeTool({
    toolCallId: `c04b-observe-${label}`,
    toolName: "observe",
    args: { label },
    tool,
    now,
  });
  expect(decision).toMatchObject({ kind: "allow" });
  if (decision.kind !== "allow" || !decision.ticket) {
    throw new Error("C04B observation not admitted");
  }
  await target.afterTool({
    ticket: decision.ticket,
    toolCallId: `c04b-observe-${label}`,
    toolName: "observe",
    result: await tool.execute(`c04b-observe-${label}`, { label }),
    isError: false,
    now: now + 1,
  });
}

function aggregateDecision(target: GovernorAgentLoopRunScope, index: number) {
  const tool = target.governedTools().find((candidate) => candidate.name === "aggregate");
  if (!tool) {
    throw new Error("C04B aggregate tool unavailable");
  }
  return target.beforeTool({
    toolCallId: `c04b-aggregate-${index}`,
    toolName: "aggregate",
    args: {},
    tool,
    now: 300 + index * 10,
  });
}

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("C04b aggregate-order behavior governor module", () => {
  it("is compiled but inert until its exact lower-case selection is activated", async () => {
    expect(BUILT_IN_BEHAVIOR_GOVERNOR_MODULES).toContain(C04B_AGGREGATE_ORDER_MODULE);
    const acquire = vi.fn();
    const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
      catalog: BUILT_IN_BEHAVIOR_GOVERNOR_MODULES,
      hostProvider: { acquire },
    });

    await lifecycle.apply([]);

    expect(acquire).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("blocks aggregation until all three distinct observations succeed", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "c04b-order-" }, async (state) => {
      const host = runtime(state.stateDir);
      const target = await scope(host);
      try {
        expect(aggregateDecision(target.scope, 1)).toMatchObject({
          kind: "block",
          reasonCode: expect.stringContaining(
            "GOVERNOR_TOOL_DEPENDENCY_UNSATISFIED:c04b-aggregate",
          ),
        });
        await observe(target.scope, "observe-c", 1);
        await observe(target.scope, "observe-a", 2);
        expect(aggregateDecision(target.scope, 2)).toMatchObject({
          kind: "block",
          reasonCode: expect.stringContaining(
            "GOVERNOR_TOOL_DEPENDENCY_UNSATISFIED:c04b-aggregate",
          ),
        });
        await observe(target.scope, "observe-b", 3);
        expect(aggregateDecision(target.scope, 3)).toMatchObject({ kind: "allow" });
      } finally {
        target.scope.dispose();
        target.close();
        host.close();
      }
    });
  });

  it("does not treat a failed observation or an unknown label as completed evidence", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c04b-hostile-" },
      async (state) => {
        const host = runtime(state.stateDir);
        const target = await scope(host);
        try {
          const observeTool = target.scope.governedTools().find((tool) => tool.name === "observe");
          if (!observeTool) {
            throw new Error("C04B observe tool unavailable");
          }
          expect(
            target.scope.beforeTool({
              toolCallId: "c04b-observe-unknown",
              toolName: "observe",
              args: { label: "unknown" },
              tool: observeTool,
              now: 200,
            }),
          ).toMatchObject({
            kind: "block",
            reasonCode: expect.stringContaining("GOVERNOR_TOOL_ARGUMENT_INVALID"),
          });
          const failed = target.scope.beforeTool({
            toolCallId: "c04b-observe-failed",
            toolName: "observe",
            args: { label: "observe-a" },
            tool: observeTool,
            now: 210,
          });
          expect(failed).toMatchObject({ kind: "allow" });
          if (failed.kind !== "allow" || !failed.ticket) {
            throw new Error("C04B failed observation not admitted");
          }
          await target.scope.afterTool({
            ticket: failed.ticket,
            toolCallId: "c04b-observe-failed",
            toolName: "observe",
            result: { content: [{ type: "text", text: "failed" }], details: null },
            isError: true,
            now: 211,
          });
          await observe(target.scope, "observe-b", 2);
          await observe(target.scope, "observe-c", 3);
          expect(aggregateDecision(target.scope, 4)).toMatchObject({
            kind: "block",
            reasonCode: expect.stringContaining(
              "GOVERNOR_TOOL_DEPENDENCY_UNSATISFIED:c04b-aggregate",
            ),
          });
        } finally {
          target.scope.dispose();
          target.close();
          host.close();
        }
      },
    );
  });

  it("does not qualify the obsolete shadow activation path", async () => {
    const create = await C04B_AGGREGATE_ORDER_MODULE.load();
    expect(() =>
      create({ ...activation, mode: "shadow", host: {} } as Parameters<typeof create>[0]),
    ).toThrow("GOVERNOR_C04B_MODE_UNQUALIFIED");
  });
});
