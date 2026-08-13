import { afterEach, describe, expect, it } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { Agent } from "../agents/runtime/index.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const capability = {
  capability: "fixture.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
} as const;

function env(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "shadow-replay-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "shadow-replay-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "shadow-replay-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "shadow-replay-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "shadow-replay-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "shadow-replay-deployment",
  };
}

const input = {
  runId: "shadow-replay-run",
  sessionKey: "shadow-replay-session",
  sessionId: "shadow-replay-session",
  agentId: "shadow-replay-agent",
  workspaceId: "shadow-replay-workspace",
  channel: "fixture-channel",
  accountId: "fixture-account",
  principalId: "fixture-principal",
  conversationId: "fixture-conversation",
  sourceMessageId: "same-message",
  sourceSequence: 1,
  prompt: "read the fixture",
  now: 100,
} as const;

function integrations() {
  return {
    evidenceOwnerId: "shadow-replay-evidence-owner",
    approvalOwnerId: "shadow-replay-approval-owner",
    deliveryOwnerId: "shadow-replay-delivery-owner",
    ownerIngressOwnerId: "shadow-replay-ingress-owner",
    childOwnerId: "shadow-replay-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "shadow-replay-account",
        gatewayInstanceId: "shadow-replay-gateway",
        ownerPrincipal: "shadow-replay-owner",
        actions: ["repair" as const],
        scopeKeys: ["shadow-replay-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 }],
    agentLoop: {
      mode: "shadow" as const,
      scopes: [{ sessionKey: input.sessionKey }],
      criteria: [{ criterionId: "observed", description: "fixture observation" }],
      toolBindings: [
        {
          toolName: "observe",
          capability: capability.capability,
          canonicalTarget: "fixture:read",
          criterionId: "observed",
          implementationId: "disposable-observation-v1" as const,
        },
      ],
      maxTurns: 4,
    },
  };
}

async function runTwice(mode: "off" | "shadow", stateDir: string): Promise<number> {
  const runtime =
    mode === "shadow"
      ? createGovernorHostRuntimeIfEnabled({
          env: env(),
          stateDir,
          capabilities: [capability],
          integrations: integrations(),
        })
      : null;
  let executions = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scope = resolveGovernorAgentLoopRunScope(input);
    let turn = 0;
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          textTool("observe", async () => {
            executions += 1;
            return { content: [{ type: "text" as const, text: "fixture" }], details: null };
          }),
        ],
      },
      streamFn: scriptedStream(() =>
        ++turn === 1
          ? assistant([{ type: "toolCall", id: `call-${attempt}`, name: "observe", arguments: {} }])
          : assistant([{ type: "text", text: "fixture reply" }]),
      ),
    });
    const bridge = scope ? installGovernorLoopBridge({ agent, scope }) : undefined;
    await agent.prompt(input.prompt);
    bridge?.dispose();
  }
  runtime?.close();
  return executions;
}

afterEach(() => closeOpenClawStateDatabase());

describe("shadow terminal replay transparency", () => {
  it("keeps exact retries visible in both absent and shadow modes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "shadow-replay-off-" },
      async (state) => {
        expect(await runTwice("off", state.stateDir)).toBe(2);
      },
    );
    await withOpenClawTestState(
      { layout: "state-only", prefix: "shadow-replay-shadow-" },
      async (state) => {
        expect(await runTwice("shadow", state.stateDir)).toBe(2);
        expect(resolveGovernorAgentLoopRunScope(input)).toBeUndefined();
      },
    );
  });

  it.each(["error", "value"] as const)(
    "preserves the pre-existing afterToolCall throw result in shadow mode (%s)",
    async (variant) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `shadow-hook-${variant}-` },
        async (state) => {
          const stateDir = state.stateDir;
          const marker =
            variant === "error"
              ? new Error("shadow-hook-error-marker")
              : { kind: "shadow-hook-value-marker" };
          const run = async (mode: "off" | "shadow") => {
            const runtime =
              mode === "shadow"
                ? createGovernorHostRuntimeIfEnabled({
                    env: env(),
                    stateDir,
                    capabilities: [capability],
                    integrations: integrations(),
                  })
                : null;
            const scope = mode === "shadow" ? resolveGovernorAgentLoopRunScope(input) : undefined;
            let turn = 0;
            let observedHistory = "";
            const agent = new Agent({
              initialState: {
                model,
                tools: [
                  textTool("observe", async () => ({
                    content: [{ type: "text" as const, text: "fixture" }],
                    details: null,
                  })),
                ],
              },
              afterToolCall: async () => {
                // oxlint-disable-next-line typescript/only-throw-error -- differential fixture uses an arbitrary legacy throw value.
                throw marker;
              },
              streamFn: scriptedStream(() => {
                if (turn++ === 1) {
                  observedHistory = JSON.stringify(agent.state.messages, (key, value) =>
                    key === "timestamp" || key === "id" || key === "toolCallId"
                      ? "<stable>"
                      : value,
                  );
                }
                return assistant(
                  turn === 1
                    ? [
                        {
                          type: "toolCall",
                          id: `shadow-hook-${mode}`,
                          name: "observe",
                          arguments: {},
                        },
                      ]
                    : [{ type: "text", text: "fixture reply" }],
                );
              }),
            });
            const bridge = scope ? installGovernorLoopBridge({ agent, scope }) : undefined;
            try {
              await agent.prompt("shadow hook");
              return observedHistory;
            } finally {
              bridge?.dispose();
              runtime?.close();
            }
          };
          const absentHistory = await run("off");
          const shadowHistory = await run("shadow");
          expect(shadowHistory).toBe(absentHistory);
        },
      );
    },
  );
});
