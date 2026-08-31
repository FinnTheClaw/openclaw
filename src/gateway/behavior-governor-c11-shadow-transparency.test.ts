import { afterEach, describe, expect, it, vi } from "vitest";
import {
  governorAgentLoopAssistant as assistant,
  governorAgentLoopFixtureModel as model,
  governorAgentLoopScriptedStream as scriptedStream,
  governorAgentLoopTool as textTool,
} from "../../test/helpers/governor-agent-loop.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import {
  Agent,
  type AfterToolCallResult,
  type BeforeToolCallResult,
} from "../agents/runtime/index.js";
import { resolveGovernorAgentLoopRunScope } from "../security/governor-agent-loop-readonly.js";
import { createGovernorHostRuntimeIfEnabled } from "../security/governor-host-bootstrap.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  C11_SHADOW_TRANSPARENCY_BEHAVIOR_GOVERNOR_MODULE,
  C11_SHADOW_TRANSPARENCY_CAPABILITY,
  C11_SHADOW_TRANSPARENCY_ID,
  C11_SHADOW_TRANSPARENCY_VERSION,
  createC11ShadowTransparencyConfiguration,
} from "./behavior-governor-c11-shadow-transparency-module.js";

const capability = Object.freeze({
  capability: C11_SHADOW_TRANSPARENCY_CAPABILITY,
  version: "1",
  sourceRank: "structured_exact" as const,
  mutating: false,
  canonicalTargetPrefixes: ["shadow://c11/"],
  requiresApproval: false,
});

type RunInput = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  channel: string;
  accountId: string;
  principalId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceSequence: number;
  prompt: string;
  now: number;
};

const run: Readonly<RunInput> = Object.freeze({
  runId: "c11-shadow-run",
  sessionKey: "c11-shadow-session",
  sessionId: "c11-shadow-session",
  agentId: "c11-shadow-agent",
  workspaceId: "c11-shadow-workspace",
  channel: "fixture-channel",
  accountId: "fixture-account",
  principalId: "fixture-principal",
  conversationId: "fixture-conversation",
  sourceMessageId: "c11-shadow-message",
  sourceSequence: 1,
  prompt: "run c11 shadow fixture",
  now: 100,
});

type Scenario =
  | "before-block"
  | "after-transform"
  | "tool-failure"
  | "provider-failure"
  | "multi-tool"
  | "deferred-tool"
  | "no-tool";

function environment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c11-shadow-identity",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c11-shadow-evidence",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c11-shadow-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c11-shadow-receipt",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c11-shadow-ledger",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c11-shadow-deployment",
  };
}

function integrations() {
  return {
    evidenceOwnerId: "c11-evidence-owner",
    approvalOwnerId: "c11-approval-owner",
    deliveryOwnerId: "c11-delivery-owner",
    ownerIngressOwnerId: "c11-ingress-owner",
    childOwnerId: "c11-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "c11-owner-account",
        gatewayInstanceId: "c11-owner-gateway",
        ownerPrincipal: "c11-owner-principal",
        actions: ["repair" as const],
        scopeKeys: ["c11-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { sink: "c11" }, generation: 0 }],
    agentLoop: createC11ShadowTransparencyConfiguration(run),
  };
}

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === "id" || key === "timestamp" || key === "toolCallId" ? "<stable>" : item,
    ),
  );
}

function withInstalledScopes(entries: readonly { scopeInstalled: boolean }[]) {
  return entries.map((entry) => Object.assign({}, entry, { scopeInstalled: true }));
}

async function execute(params: {
  mode: "off" | "shadow";
  scenario: Scenario;
  stateDir: string;
  input?: Readonly<RunInput>;
  runtime?: NonNullable<ReturnType<typeof createGovernorHostRuntimeIfEnabled>>;
}) {
  const input = params.input ?? run;
  const ownedRuntime =
    params.runtime ??
    (params.mode === "shadow"
      ? createGovernorHostRuntimeIfEnabled({
          env: environment(),
          stateDir: params.stateDir,
          capabilities: [capability],
          integrations: integrations(),
        })
      : null);
  let requests = 0;
  let executions = 0;
  let turn = 0;
  const stream =
    params.scenario === "provider-failure"
      ? () => {
          requests += 1;
          throw new Error("c11-provider-failure");
        }
      : scriptedStream(() => {
          requests += 1;
          turn += 1;
          if (params.scenario === "no-tool") {
            return assistant([{ type: "text", text: "no-tool" }]);
          }
          if (params.scenario === "deferred-tool" && turn === 1) {
            return assistant([{ type: "text", text: "deferred" }]);
          }
          if (turn === 1) {
            const calls =
              params.scenario === "multi-tool"
                ? ["one", "two"].map((key) => ({
                    type: "toolCall" as const,
                    id: `c11-${key}`,
                    name: "read",
                    arguments: { key },
                  }))
                : [
                    {
                      type: "toolCall" as const,
                      id: "c11-read",
                      name: "read",
                      arguments: { key: "one" },
                    },
                  ];
            return assistant(calls);
          }
          return assistant([{ type: "text", text: "done" }]);
        });
  const beforeToolCall =
    params.scenario === "before-block"
      ? async (): Promise<BeforeToolCallResult> => ({ block: true, reason: "prior-block" })
      : undefined;
  const afterToolCall =
    params.scenario === "after-transform"
      ? async (): Promise<AfterToolCallResult> => ({
          content: [{ type: "text", text: "prior-transformed" }],
          details: { prior: true },
        })
      : undefined;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        textTool("read", async () => {
          executions += 1;
          if (params.scenario === "tool-failure") {
            throw new Error("c11-tool-failure");
          }
          return { content: [{ type: "text" as const, text: "tool-result" }], details: null };
        }),
      ],
    },
    ...(beforeToolCall ? { beforeToolCall } : {}),
    ...(afterToolCall ? { afterToolCall } : {}),
    streamFn: stream,
  });
  const steer = vi.spyOn(agent, "steerKeyed");
  const scope = params.mode === "shadow" ? resolveGovernorAgentLoopRunScope(input) : undefined;
  const bridge = scope ? installGovernorLoopBridge({ agent, scope, now: () => 200 }) : undefined;
  let failure: string | undefined;
  try {
    await agent.prompt(input.prompt);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    bridge?.dispose();
    if (!params.runtime) {
      ownedRuntime?.close();
    }
  }
  return Object.freeze({
    failure,
    messages: stable(agent.state.messages),
    requests,
    executions,
    steerCalls: steer.mock.calls.length,
    scopeInstalled: Boolean(scope),
  });
}

async function parity(scenario: Scenario): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: `c11-off-${scenario}-` },
    async (off) => {
      const absent = await execute({ mode: "off", scenario, stateDir: off.stateDir });
      await withOpenClawTestState(
        { layout: "state-only", prefix: `c11-shadow-${scenario}-` },
        async (shadow) => {
          const observed = await execute({ mode: "shadow", scenario, stateDir: shadow.stateDir });
          expect(observed).toEqual({ ...absent, scopeInstalled: true });
        },
      );
    },
  );
}

afterEach(() => closeOpenClawStateDatabase());

describe("C11 shadow transparency", () => {
  it("is a lowercase, independently selectable, shadow-only module", async () => {
    expect(C11_SHADOW_TRANSPARENCY_BEHAVIOR_GOVERNOR_MODULE).toMatchObject({
      id: C11_SHADOW_TRANSPARENCY_ID,
      version: C11_SHADOW_TRANSPARENCY_VERSION,
      supportedModes: ["shadow"],
      qualifiedModes: ["shadow"],
      dependencies: [],
      durableBoundaryIds: [],
    });
    const factory = await C11_SHADOW_TRANSPARENCY_BEHAVIOR_GOVERNOR_MODULE.load();
    expect(() =>
      factory({
        id: C11_SHADOW_TRANSPARENCY_ID,
        version: C11_SHADOW_TRANSPARENCY_VERSION,
        mode: "enforce",
      } as never),
    ).toThrow("GOVERNOR_C11_MODE_UNQUALIFIED");
  });

  it("preserves a prior beforeTool block without executing the tool", () => parity("before-block"));
  it("preserves transformed prior afterTool output", () => parity("after-transform"));
  it("preserves tool failures and rejections", () => parity("tool-failure"));
  it("preserves provider-stream failures", () => parity("provider-failure"));
  it("preserves multi-tool, deferred, and no-tool turns", async () => {
    await parity("multi-tool");
    await parity("deferred-tool");
    await parity("no-tool");
  });

  it("does not stop, steer, deliver, or retry beyond the absent route", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c11-no-control-off-" },
      async (off) => {
        const absent = await execute({
          mode: "off",
          scenario: "multi-tool",
          stateDir: off.stateDir,
        });
        await withOpenClawTestState(
          { layout: "state-only", prefix: "c11-no-control-shadow-" },
          async (shadow) => {
            const observed = await execute({
              mode: "shadow",
              scenario: "multi-tool",
              stateDir: shadow.stateDir,
            });
            expect(observed.steerCalls).toBe(0);
            expect(observed).toEqual({ ...absent, scopeInstalled: true });
          },
        );
      },
    );
  });

  it("keeps legacy out-of-scope runs absent", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c11-out-of-scope-" },
      async (state) => {
        const outOfScope = {
          ...run,
          sessionKey: "legacy-session",
          agentId: "legacy-agent",
        } as const;
        const observed = await execute({
          mode: "shadow",
          scenario: "no-tool",
          stateDir: state.stateDir,
          input: outOfScope,
        });
        expect(observed.scopeInstalled).toBe(false);
      },
    );
  });

  it("adds no model request or visible output on concurrent private observations", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c11-concurrent-off-" },
      async (off) => {
        const absent = await Promise.all([
          execute({ mode: "off", scenario: "multi-tool", stateDir: off.stateDir }),
          execute({
            mode: "off",
            scenario: "no-tool",
            stateDir: off.stateDir,
            input: {
              ...run,
              runId: "c11-shadow-run-parallel",
              sourceMessageId: "c11-shadow-message-2",
              sourceSequence: 2,
            },
          }),
        ]);
        await withOpenClawTestState(
          { layout: "state-only", prefix: "c11-concurrent-shadow-" },
          async (shadow) => {
            const runtime = createGovernorHostRuntimeIfEnabled({
              env: environment(),
              stateDir: shadow.stateDir,
              capabilities: [capability],
              integrations: integrations(),
            });
            try {
              const observed = await Promise.all([
                execute({
                  mode: "shadow",
                  scenario: "multi-tool",
                  stateDir: shadow.stateDir,
                  runtime: runtime!,
                }),
                execute({
                  mode: "shadow",
                  scenario: "no-tool",
                  stateDir: shadow.stateDir,
                  input: {
                    ...run,
                    runId: "c11-shadow-run-parallel",
                    sourceMessageId: "c11-shadow-message-2",
                    sourceSequence: 2,
                  },
                  runtime: runtime!,
                }),
              ]);
              expect(observed).toEqual(withInstalledScopes(absent));
            } finally {
              runtime?.close();
            }
          },
        );
      },
    );
  });
});
