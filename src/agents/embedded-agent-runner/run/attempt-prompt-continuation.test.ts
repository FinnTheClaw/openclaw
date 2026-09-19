import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();
const sessionId = "continuation-goal-anchor";
const originalRequest =
  "Now change status.txt from ready to shipped and confirm. Do not change other files.";
const continuation =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue the original user request from that partial turn.\n\nExact original user request to finish:\n" +
  originalRequest;

let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
beforeEach(() => {
  admission = prepareSystemAgentRunAdmission({}, sessionId, "main", "continuation-goal-anchor");
});

afterEach(() => {
  admission.close();
  clearEmbeddedSessionPromptStates([sessionId]);
  forgetPromptBuildDrainCacheForRun(sessionId);
});

describe("internal continuation provider boundary", () => {
  it.each([false, true])(
    "keeps the exact goal in hidden continuation context (append-only=%s)",
    async (appendOnlyRuntimeContext) => {
      const originalUser = {
        role: "user" as const,
        content: originalRequest,
        timestamp: 1,
        idempotencyKey: "current-user",
      };
      const manager = SessionManager.inMemory();
      manager.appendMessage(originalUser);
      manager.appendMessage(
        createAssistant(
          testModel,
          [
            {
              type: "toolCall",
              id: "read-status",
              name: "read",
              arguments: { path: "status.txt" },
            },
          ],
          "toolUse",
        ),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "read-status",
        toolName: "read",
        content: [{ type: "text", text: "shipped\n" }],
        isError: false,
        timestamp: 2,
      });
      manager.appendMessage(
        createAssistant(testModel, [
          { type: "thinking", thinking: "The change has been verified." },
        ]),
      );
      const recorder = createUserTurnTranscriptRecorder({
        message: originalUser,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(originalUser);
      let suppressedRuntimeUser: AgentMessage | undefined;
      const sessionManager = guardSessionManager(manager, {
        runId: sessionId,
        suppressNextUserMessagePersistence: true,
        onUserMessagePersistenceSuppressed: (_message, runtimeMessage) => {
          suppressedRuntimeUser = runtimeMessage;
        },
      });
      const requests: Context["messages"][] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(structuredClone(context.messages));
        return createAssistantResultStream(
          createAssistant(model, [{ type: "text", text: "Changed status.txt to shipped." }]),
        );
      });
      const { session } = await createTestSession({ sessionManager });
      const attempt = {
        admittedRunContext: await admission.admit("embedded"),
        config: {},
        operation: "attempt",
        model: testModel,
        modelId: testModel.id,
        provider: testModel.provider,
        prompt: continuation,
        transcriptPrompt: originalRequest,
        runId: sessionId,
        sessionId,
        trigger: "user",
        workspaceDir: "/tmp",
        suppressNextUserMessagePersistence: true,
        skipPreparedUserTurnMessage: true,
        userTurnTranscriptRecorder: recorder,
      } as EmbeddedRunAttemptParams;
      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession: session,
        appendOnlyRuntimeContext,
        attempt,
        getUserTranscriptContexts: () =>
          suppressedRuntimeUser
            ? [{ runtimeMessage: suppressedRuntimeUser, transcriptMessage: originalUser }]
            : [],
        isRawModelRun: false,
        preparedUserTurnMessage: undefined,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      const prompt = await prepareEmbeddedAttemptPromptAssembly({
        attempt,
        activeSession: session,
        sessionManager,
        hookRunner: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "11111111111111111111111111111111" },
        isRawModelRun: false,
        orphanRepair: boundary.orphanRepair,
        sessionAgentId: "main",
        runtimeModel: testModel.id,
        systemPromptText: "Test system prompt",
        applyPromptBuildToolsAllow: () => [],
        setActiveSessionSystemPrompt: vi.fn(),
        setLeasedSteering: vi.fn(),
        cache: {
          observabilityEnabled: false,
          retention: "none",
          streamStrategy: "default",
          transport: "sse",
          tools: [],
          trace: null,
        },
      });
      const state = getEmbeddedSessionPromptState(sessionId);
      const context = prepareEmbeddedAttemptPromptContext({
        attempt,
        appendOnlyRuntimeContext,
        boundaryTimezone: boundary.boundaryTimezone,
        includeBoundaryTimestamp: boundary.includeBoundaryTimestamp,
        isRawModelRun: false,
        messages: session.messages,
        prompt,
        replaceSessionMessages: (messages) => {
          session.agent.state.messages = messages;
        },
        sessionAgentId: "main",
        setActiveSessionSystemPrompt: vi.fn(),
        systemPromptText: "Test system prompt",
        toolResultPromptProjectionState: state.toolResults,
      });
      boundary.setCurrentUserTimestampOverride(context.currentUserTimestampOverride);
      await submitEmbeddedAttemptPrompt({
        attempt,
        activeSession: session,
        appendOnlyRuntimeContext,
        contextTokenBudget: context.contextTokenBudget,
        images: [],
        modelPrompt: context.promptForModel,
        onFinalPromptText: vi.fn(),
        onSteeringAcknowledged: vi.fn(),
        promptActiveSession: (text, options) => session.prompt(text, options),
        runtimeContextMessage: context.runtimeContextMessageForCurrentTurn,
        runtimeOnly: context.promptSubmission.runtimeOnly === true,
        sessionPromptState: state,
        systemPrompt: "Test system prompt",
        toolResultAggregateMaxChars: context.promptToolResultAggregateMaxChars,
        toolResultMaxChars: context.promptToolResultMaxChars,
        toolResultPromptProjectionState: state.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: prompt.transcriptLeafId,
        transcriptPrompt: context.promptForSession,
      });
      expect(requests).toHaveLength(1);
      const carrier = requests[0]!.find(
        (message) => message.role === "user" && message.runtimeContextCarrier,
      );
      expect(carrier).toBeDefined();
      expect(JSON.stringify(carrier)).toContain(
        JSON.stringify("Exact original user request to finish:\n" + originalRequest).slice(1, -1),
      );
      const persistedUsers = manager
        .getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "user");
      expect(persistedUsers).toHaveLength(1);
      expect(JSON.stringify(persistedUsers)).not.toContain("Exact original user request");
    },
  );
});
