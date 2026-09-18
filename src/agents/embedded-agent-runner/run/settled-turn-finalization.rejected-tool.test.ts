import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeOpenAICompletionsToolCalls } from "../../../../packages/ai/src/providers/openai-completions-tool-calls.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { buildEmbeddedRunnerAssistant } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";

const backendMocks = vi.hoisted(() => ({ runSettledFinalization: vi.fn() }));
vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: () => undefined,
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));

describe("settled finalization after a rejected tool terminal", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  let admittedRunContext: Awaited<ReturnType<typeof admission.admit>>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "rejected-tool-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => admission.close());
  it.each([false, true])(
    "finalizes a completed status edit after a whitespace tool name (reported: %s)",
    async (reported) => {
      const confirmed = vi.fn();
      const malformedCall = {
        type: "toolCall" as const,
        id: "rejected",
        name: "\n",
        arguments: {},
        partialArgs: "{}",
      };
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [{ type: "text", text: "Confirmed —\u0060\n\n" }, malformedCall],
      });
      finalizeOpenAICompletionsToolCalls(assistant, { onConfirmedToolCall: confirmed });
      expect(confirmed).not.toHaveBeenCalled();
      expect(assistant.stopReason).toBe("error");
      expect(assistant.content).toEqual([{ type: "text", text: "Confirmed —\u0060\n\n" }]);
      const attempt = createSettledProviderFailureAttempt({
        assistantTexts: ["Confirmed —\u0060\n\n"],
        messagesSnapshot: [
          { role: "user", content: "Change status.txt from ready to shipped", timestamp: 0 },
          buildEmbeddedRunnerAssistant({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call-write",
                name: "write",
                arguments: { path: "status.txt", content: "shipped" },
              },
            ],
          }),
          {
            role: "toolResult",
            toolCallId: "call-write",
            toolName: "write",
            isError: false,
            timestamp: 1,
            content: [{ type: "text", text: "status.txt changed from ready to shipped" }],
          },
          assistant,
        ],
      });
      if (reported) {
        attempt.terminal = { kind: "ok" };
      }
      backendMocks.runSettledFinalization.mockResolvedValueOnce({
        outcome: "answered",
        result: {
          assistant: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "status.txt now says shipped." }],
          }),
        },
      });
      const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
      input.terminalBase.runParams.trigger = "user";
      input.finalization.modelApi = "openai-completions";
      const result = await prepareTerminalWithSettledTurnFinalization(input);
      expect(result.finalizationOutcome).toBe("answered");
      expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
      const [prepared, settled] = backendMocks.runSettledFinalization.mock.calls[0];
      expect(prepared).toMatchObject({
        operation: "settled-tool-finalization",
        disableTools: true,
      });
      expect(settled).toBe(attempt);
      expect(
        settled.messagesSnapshot.filter(
          (message: { role: string }) => message.role === "toolResult",
        ),
      ).toHaveLength(1);
      expect(result.prepared.payloadsWithToolMedia).toEqual([
        expect.objectContaining({ text: "status.txt now says shipped." }),
      ]);
      expect(confirmed).not.toHaveBeenCalled();
    },
  );
});
