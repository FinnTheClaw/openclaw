import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createEmbeddedAgentRunnerOpenAiConfig,
  createEmbeddedAgentRunnerTestWorkspace,
  createMockUsage,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
  type EmbeddedAgentRunnerTestWorkspace,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const attempt = vi.fn();
const disposeMcp = vi.fn(async (_sessionId: string) => undefined);
const resolveSession = vi.fn();
const resolveStoredSession = vi.fn();
const resolveModel = vi.fn(async (provider: string, modelId: string) => ({
  model: {
    api: "openai-responses",
    provider,
    id: modelId,
    contextWindow: 16_000,
    maxTokens: 2048,
    input: ["text"],
  },
  error: undefined,
  authStorage: { setRuntimeApiKey: () => undefined },
  modelRegistry: {},
}));
const ensureModels = vi.fn(async () => ({ wrote: false }));
const hookRunner = {
  hasHooks: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeAgentReply: vi.fn<
    (
      payload: unknown,
      context: unknown,
    ) => Promise<{ handled?: boolean; reply?: { text?: string } } | undefined>
  >(async () => undefined),
};

vi.mock("openclaw/plugin-sdk/llm", async () => {
  const actual =
    await vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm");
  const message = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });
  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => message(model),
    completeSimple: async (model: { api: string; provider: string; id: string }) => message(model),
  };
});

function installMocks() {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => hookRunner),
    getGlobalPluginRegistry: vi.fn(() => null),
    hasGlobalHooks: vi.fn(() => false),
    initializeGlobalHookRunner: vi.fn(),
    resetGlobalHookRunner: vi.fn(),
  }));
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => attempt(params) });
  vi.doMock("./command/session.js", async () => {
    const actual =
      await vi.importActual<typeof import("./command/session.js")>("./command/session.js");
    return {
      ...actual,
      resolveSessionKeyForRequest: (options: unknown) => resolveSession(options),
      resolveStoredSessionKeyForSessionId: (options: unknown) => resolveStoredSession(options),
    };
  });
  vi.doMock("./agent-bundle-mcp-tools.js", () => ({
    disposeSessionMcpRuntime: (sessionId: string) => disposeMcp(sessionId),
    retireSessionMcpRuntimeForSessionKey: () => Promise.resolve(false),
    retireSessionMcpRuntime: ({ sessionId }: { sessionId?: string | null }) =>
      sessionId ? disposeMcp(sessionId) : Promise.resolve(false),
  }));
  vi.doMock("./embedded-agent-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./embedded-agent-runner/model.js")>(
      "./embedded-agent-runner/model.js",
    );
    return {
      ...actual,
      resolveModelAsync: (...args: Parameters<typeof resolveModel>) => resolveModel(...args),
    };
  });
  vi.doMock("./embedded-agent-runner/run/auth-controller.js", () => ({
    createEmbeddedRunAuthController: () => ({
      advanceAuthProfile: vi.fn(async () => false),
      initializeAuthProfile: vi.fn(async () => undefined),
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
      stopRuntimeAuthRefreshTimer: vi.fn(),
    }),
  }));
  vi.doMock("./models-config.js", async () => {
    const actual = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...actual,
      ensureOpenClawModelsJson: (...args: Parameters<typeof ensureModels>) => ensureModels(...args),
    };
  });
}

const capability: GovernorCapabilityDefinition = {
  capability: "embedded.fixture.observe",
  version: "1",
  sourceRank: "structured_exact",
  mutating: false,
  canonicalTargetPrefixes: ["fixture:"],
  requiresApproval: false,
};

function createRuntime(stateDir: string, sessionKey: string) {
  return createGovernorHostRuntimeIfEnabled({
    env: {
      OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
      NODE_ENV: "test",
      OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "embedded-replay-identity",
      OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "embedded-replay-evidence",
      OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "embedded-replay-evidence-v1",
      OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "embedded-replay-receipt",
      OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "embedded-replay-ledger",
      OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "embedded-replay-deployment",
    },
    stateDir,
    capabilities: [capability],
    integrations: {
      evidenceOwnerId: "embedded-replay-evidence-owner",
      approvalOwnerId: "embedded-replay-approval-owner",
      deliveryOwnerId: "embedded-replay-delivery-owner",
      ownerIngressOwnerId: "embedded-replay-ingress-owner",
      childOwnerId: "embedded-replay-child-owner",
      ownerIngressBindings: [
        {
          channel: "signal",
          accountId: "embedded-replay-account",
          gatewayInstanceId: "embedded-replay-gateway",
          ownerPrincipal: "embedded-replay-owner",
          actions: ["repair"],
          scopeKeys: ["embedded-replay-scope"],
        },
      ],
      deliveries: [
        { implementationId: "synthetic", config: { channel: "fixture" }, generation: 0 },
      ],
      agentLoop: {
        mode: "enforce",
        scopes: [{ sessionKey }],
        criteria: [{ criterionId: "alpha", description: "Observe alpha" }],
        toolBindings: [
          {
            toolName: "observe",
            capability: capability.capability,
            canonicalTarget: "fixture:observe",
            criterionArgument: "key",
            criteriaByValue: { alpha: "alpha" },
            implementationId: "disposable-observation-v1",
          },
        ],
        maxTurns: 4,
        expectedAssistantTextDigest: governorDigest("done"),
      },
    },
  });
}

let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let createGovernorHostRuntimeIfEnabled: typeof import("../security/governor-host-bootstrap.js").createGovernorHostRuntimeIfEnabled;
let closeOpenClawStateDatabase: typeof import("../state/openclaw-state-db.js").closeOpenClawStateDatabase;
let workspace: EmbeddedAgentRunnerTestWorkspace | undefined;
let clearConfig: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let agentDir = "";
let workspaceDir = "";
let counter = 0;

beforeAll(async () => {
  vi.resetModules();
  installMocks();
  ({ clearRuntimeConfigSnapshot: clearConfig } = await import("../config/config.js"));
  ({ createGovernorHostRuntimeIfEnabled } = await import("../security/governor-host-bootstrap.js"));
  ({ closeOpenClawStateDatabase } = await import("../state/openclaw-state-db.js"));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  workspace = await createEmbeddedAgentRunnerTestWorkspace("openclaw-completed-replay-");
  agentDir = workspace.agentDir;
  workspaceDir = workspace.workspaceDir;
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedAgentRunnerTestWorkspace(workspace);
  workspace = undefined;
});

beforeEach(() => {
  clearConfig();
  attempt.mockReset();
  resolveSession.mockReset();
  resolveStoredSession.mockReset();
  disposeMcp.mockReset();
  resolveModel.mockClear();
  ensureModels.mockClear();
  hookRunner.hasHooks.mockReset();
  hookRunner.hasHooks.mockReturnValue(false);
  hookRunner.runBeforeAgentReply.mockReset();
  hookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
});

describe("embedded runner completed replay", () => {
  it("does no provider, tool, event, or reply work for an exact completed source replay", async () => {
    const sessionKey = `agent:test:completed-replay-${++counter}`;
    const sessionFile = path.join(workspaceDir, `session-${counter}.jsonl`);
    const runtime = createRuntime(path.join(workspaceDir, "state"), sessionKey);
    resolveSession.mockReturnValue({ sessionKey, sessionStore: {}, storePath: sessionFile });
    let physicalTools = 0;
    let completedTaskId: GovernorTaskId | undefined;
    const abortController = new AbortController();
    const addAbortListener = vi.spyOn(abortController.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener");
    const onExecutionStarted = vi.fn();
    const onExecutionPhase = vi.fn();
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
    hookRunner.runBeforeAgentReply
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ handled: true, reply: { text: "must-not-run" } });
    attempt.mockImplementationOnce(async (rawParams: unknown) => {
      const scope = (
        rawParams as {
          governorAgentLoopScope?: import("../security/governor-agent-loop-types.js").GovernorAgentLoopRunScope;
        }
      ).governorAgentLoopScope;
      if (!scope) {
        throw new Error("completed replay scope missing");
      }
      completedTaskId = scope.taskId as GovernorTaskId;
      const decision = scope.beforeTool({
        toolCallId: "embedded-replay-tool",
        toolName: "observe",
        args: { key: "alpha" },
        tool: scope.governedTools()[0],
        now: 100,
      });
      if (decision.kind !== "allow" || !decision.ticket) {
        throw new Error("admission failed");
      }
      physicalTools += 1;
      scope.afterTool({
        ticket: decision.ticket,
        toolCallId: "embedded-replay-tool",
        toolName: "observe",
        result: { content: [{ type: "text", text: "alpha" }], details: null },
        isError: false,
        now: 101,
      });
      expect(scope.afterTurn({ assistantText: "", toolCallCount: 1, now: 102 })).toMatchObject({
        kind: "continue",
      });
      expect(scope.afterTurn({ assistantText: "done", toolCallCount: 0, now: 103 })).toMatchObject({
        kind: "complete",
      });
      scope.dispose();
      return makeEmbeddedRunnerAttempt({
        assistantTexts: ["done"],
        lastAssistant: buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "done" }] }),
      });
    });
    const params = {
      sessionId: sessionKey,
      sessionKey,
      sessionFile,
      workspaceDir,
      config: createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
      prompt: "observe alpha",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      currentMessageId: "embedded-replay-source",
      trigger: "cron",
      abortSignal: abortController.signal,
      onExecutionStarted,
      onExecutionPhase,
      enqueue: immediateEnqueue,
    } as const;
    try {
      const first = await runEmbeddedAgent({ ...params, runId: "completed-first" });
      expect(first.meta.error).toBeUndefined();
      expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
      expect(onExecutionStarted).toHaveBeenCalledTimes(1);
      expect(onExecutionPhase).toHaveBeenCalled();
      expect(addAbortListener).toHaveBeenCalled();
      expect(removeAbortListener).toHaveBeenCalledTimes(addAbortListener.mock.calls.length);
      const taskId = completedTaskId;
      if (!taskId) {
        throw new Error("completed replay task missing");
      }
      const events = runtime!.adapter.controller.store.listEvents(taskId);
      const attempts = attempt.mock.calls.length;
      const hookCalls = hookRunner.runBeforeAgentReply.mock.calls.length;
      const startedCalls = onExecutionStarted.mock.calls.length;
      const phaseCalls = onExecutionPhase.mock.calls.length;
      const addedListeners = addAbortListener.mock.calls.length;
      const removedListeners = removeAbortListener.mock.calls.length;
      const modelCalls = resolveModel.mock.calls.length;
      const modelConfigCalls = ensureModels.mock.calls.length;
      const second = await runEmbeddedAgent({ ...params, runId: "completed-replay" });
      expect(attempt).toHaveBeenCalledTimes(attempts);
      expect(physicalTools).toBe(1);
      expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(hookCalls);
      expect(onExecutionStarted).toHaveBeenCalledTimes(startedCalls);
      expect(onExecutionPhase).toHaveBeenCalledTimes(phaseCalls);
      expect(addAbortListener).toHaveBeenCalledTimes(addedListeners);
      expect(removeAbortListener).toHaveBeenCalledTimes(removedListeners);
      expect(resolveModel).toHaveBeenCalledTimes(modelCalls);
      expect(ensureModels).toHaveBeenCalledTimes(modelConfigCalls);
      expect(runtime!.adapter.controller.store.listEvents(taskId)).toEqual(events);
      expect(second.payloads ?? []).toEqual([]);
      expect(second.didSendViaMessagingTool).toBeUndefined();
      expect(second.didDeliverSourceReplyViaMessageTool).toBeUndefined();
      expect(second.meta).toMatchObject({
        terminalReplyKind: "silent-empty",
        stopReason: "completed_replay",
      });
    } finally {
      runtime?.close();
      closeOpenClawStateDatabase();
    }
  });
});
