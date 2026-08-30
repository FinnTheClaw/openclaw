import { afterEach, describe, expect, it } from "vitest";
import {
  governorAgentLoopAssistant,
  governorAgentLoopFixtureModel,
  governorAgentLoopScriptedStream,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { installGatewayBehaviorGovernorModuleAgentLoop } from "../gateway/behavior-governor-module-agent-loop.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorAgentLoopScopeProvider } from "./governor-agent-loop-scope-provider.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import {
  bindGovernorC02TestHost,
  governorC02TestEnvironment,
  governorC02TestHostRegistration,
  normalizedC02GatewayRegistry,
} from "./governor-c02-runtime-test-fixture.test.js";
import {
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostRuntime,
} from "./governor-host-bootstrap.js";

const capabilities = [
  {
    capability: "read",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/observations"],
    requiresApproval: false,
  },
  {
    capability: "exec",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/aggregate"],
    requiresApproval: false,
  },
];

const config: GovernorAgentLoopConfiguration = {
  moduleIdentity: { id: "c02-simple-efficiency", version: "v1" },
  hostCapabilities: { installedToolInventory: true, toolTurnProvenance: true },
  mode: "enforce",
  scopes: [{ sessionKey: "c02-session-key", agentId: "c02-agent" }],
  criteria: [
    { criterionId: "c02-observe-a", description: "observe a" },
    { criterionId: "c02-observe-b", description: "observe b" },
    {
      criterionId: "c02-aggregate",
      description: "aggregate",
      dependsOnCriteria: ["c02-observe-a", "c02-observe-b"],
    },
  ],
  toolBindings: [
    {
      toolName: "read",
      capability: "read",
      canonicalTarget: "campaign://c02/observations",
      criterionArgument: "path",
      criteriaByValue: {
        "/case/alpha.txt": "c02-observe-a",
        "/case/beta.txt": "c02-observe-b",
      },
      implementationId: "installed-tool:read",
    },
    {
      toolName: "exec",
      capability: "exec",
      canonicalTarget: "campaign://c02/aggregate",
      criterionArgument: "command",
      criteriaByValue: { "/usr/bin/python3 -c 'print(3)'": "c02-aggregate" },
      implementationId: "installed-tool:exec",
    },
  ],
  maxTurns: 8,
};

function run(runId: string): GovernorAgentLoopRunInput {
  return {
    runId,
    sessionKey: "c02-session-key",
    sessionId: "c02-session",
    agentId: "c02-agent",
    workspaceId: "c02-workspace",
    channel: "c02-channel",
    accountId: "c02-account",
    principalId: "c02-principal",
    conversationId: "c02-conversation",
    sourceMessageId: "c02-message-1",
    sourceSequence: 1,
    prompt: "run exact c02 campaign",
    now: 100,
  };
}

function runtime(stateDir: string, invocationId: string): GovernorHostRuntime {
  const host = createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: governorC02TestEnvironment(invocationId),
    stateDir,
    capabilities,
    integrations: {
      evidenceOwnerId: "c02-evidence-owner",
      approvalOwnerId: "c02-approval-owner",
      deliveryOwnerId: "c02-delivery-owner",
      ownerIngressOwnerId: "c02-ingress-owner",
      childOwnerId: "c02-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "c02-owner-account",
          gatewayInstanceId: "c02-owner-gateway",
          ownerPrincipal: "c02-owner-principal",
          actions: ["repair"],
          scopeKeys: ["c02-owner-scope"],
        },
      ],
      deliveries: [{ implementationId: "synthetic", config: {}, generation: 0 }],
    },
  });
  if (!host) {
    throw new Error("C02 host unavailable");
  }
  bindGovernorC02TestHost(host, capabilities, invocationId);
  return host;
}

function unpreparedScope(host: GovernorHostRuntime, input: GovernorAgentLoopRunInput) {
  const provider = createGovernorAgentLoopScopeProvider({
    controller: host.adapter.controller,
    submitObservedReceipt: host.owners.evidence.submitObservedReceipt,
    capabilities,
    config,
  });
  const base = provider.resolveRunScope(input);
  if (!base) {
    throw new Error("C02 scope unavailable");
  }
  return governorC02TestHostRegistration(host).wrap({
    scope: base,
    run: input,
    config,
    modulePlanDigest: governorDigest({ schema: "test-c02-plan" }),
    hostDescriptorDigest: "a".repeat(64),
  });
}

function gatewayScope(host: GovernorHostRuntime, input: GovernorAgentLoopRunInput) {
  let issued = false;
  const handle = installGatewayBehaviorGovernorModuleAgentLoop([
    {
      activation: { id: "c02-simple-efficiency", version: "v1", mode: "enforce" },
      agentLoop: {
        resolveRunScope() {
          if (issued) {
            return undefined;
          }
          issued = true;
          return unpreparedScope(host, input);
        },
      },
    },
  ]);
  const scope = resolveGovernorAgentLoopRunScope(input);
  if (!handle || !scope) {
    handle?.close();
    throw new Error("C02 gateway scope unavailable");
  }
  return { scope, close: handle.close };
}

function assistant(
  content: Parameters<typeof governorAgentLoopAssistant>[0],
  finnRequestIds: readonly string[],
) {
  return Object.assign(governorAgentLoopAssistant(content), {
    finnRequestIds,
    finnRequestIdEvidenceComplete: true,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("C02 embedded Agent restart composition", () => {
  it("recreates the gateway and merges a fresh post-restart Finn collector", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-agent-restart-" },
      async (state) => {
        const tools = normalizedC02GatewayRegistry();
        const firstHost = runtime(state.stateDir, "c02-systemd-a");
        const firstGateway = gatewayScope(firstHost, run("c02-gateway-a"));
        const firstScope = firstGateway.scope;
        let firstTurn = 0;
        const firstAgent = new Agent({
          initialState: { model: governorAgentLoopFixtureModel, tools: [...tools] },
          streamFn: governorAgentLoopScriptedStream(() => {
            firstTurn += 1;
            return firstTurn === 1
              ? assistant(
                  [
                    {
                      type: "toolCall",
                      id: "c02-call-1",
                      name: "read",
                      arguments: { path: "/case/alpha.txt" },
                    },
                  ],
                  ["req_c02_pre_1"],
                )
              : assistant(
                  [
                    {
                      type: "toolCall",
                      id: "c02-call-2",
                      name: "read",
                      arguments: { path: "/case/beta.txt" },
                    },
                  ],
                  ["req_c02_pre_1", "req_c02_pre_2"],
                );
          }),
        });
        const firstBridge = installGovernorLoopBridge({
          agent: firstAgent,
          scope: firstScope,
          now: (() => {
            let value = 200;
            return () => ++value;
          })(),
        });
        const ready = new Promise<void>((resolve) => {
          const unsubscribe = onAgentEvent((event) => {
            if (event.runId === "c02-gateway-a" && event.stream === "governor_checkpoint") {
              unsubscribe();
              firstAgent.abort();
              resolve();
            }
          });
        });
        await Promise.allSettled([firstAgent.prompt("start"), ready]);
        expect(firstScope.disposition).toBe("checkpoint_pending");
        const persistedMessages = [...firstAgent.state.messages];
        firstBridge.dispose();
        firstGateway.close();
        firstHost.close();

        const secondHost = runtime(state.stateDir, "c02-systemd-b");
        const secondGateway = gatewayScope(secondHost, run("c02-gateway-b"));
        const secondScope = secondGateway.scope;
        let secondTurn = 0;
        const secondAgent = new Agent({
          initialState: {
            model: governorAgentLoopFixtureModel,
            tools: [...tools],
            messages: persistedMessages,
          },
          streamFn: governorAgentLoopScriptedStream(() => {
            secondTurn += 1;
            return secondTurn === 1
              ? assistant(
                  [
                    {
                      type: "toolCall",
                      id: "c02-call-3",
                      name: "exec",
                      arguments: { command: "/usr/bin/python3 -c 'print(3)'" },
                    },
                  ],
                  ["req_c02_post_1"],
                )
              : assistant([{ type: "text", text: "done" }], ["req_c02_post_1", "req_c02_post_2"]);
          }),
        });
        const secondBridge = installGovernorLoopBridge({
          agent: secondAgent,
          scope: secondScope,
          now: (() => {
            let value = 400;
            return () => ++value;
          })(),
        });
        await secondAgent.prompt("resume");
        secondBridge.assertTerminal();
        expect(secondBridge.terminalEvidence()?.coordinatorRequestIds).toEqual([
          "req_c02_pre_1",
          "req_c02_pre_2",
          "req_c02_post_1",
          "req_c02_post_2",
        ]);
        secondBridge.dispose();
        secondGateway.close();
        secondHost.close();
      },
    );
  });
});
