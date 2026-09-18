import { describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function prepareRequest(
  attempt = createSettledProviderFailureAttempt(),
  trigger: "user" | "cron" = "user",
): Parameters<typeof resolveSettledTurnFinalizationRequest>[0] {
  const { initial, terminalBase, finalization } = createSettledFinalizationTestInput(
    attempt,
    createTestAdmittedRunContext("run-settled"),
  );
  terminalBase.runParams.trigger = trigger;
  const prepared = prepareEmbeddedRunTerminal({ ...terminalBase, ...initial });
  return {
    runParams: terminalBase.runParams,
    attempt,
    activeErrorContext: terminalBase.activeErrorContext,
    modelApi: finalization.modelApi,
    executionContract: finalization.executionContract,
    payloadsWithToolMedia: prepared.payloadsWithToolMedia,
    recoveredFinalAssistantPayloadsAfterPromptTimeout:
      prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
    terminalState: initial.terminalState,
    hasTerminalToolPresentation: false,
    settledTurnFinalizationAvailable: true,
  };
}

describe("prepared provider errors after settled tools", () => {
  it("does not mistake the generated provider error for an authored answer", () => {
    const request = prepareRequest();
    expect(request.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("connection refused"),
      }),
    ]);
    expect(resolveSettledTurnFinalizationRequest(request)).toContain(
      "Do not repeat completed calls or claim unperformed work.",
    );
  });

  it.each([
    { name: "missing recovery context", change: { settledTurnFinalizationContext: undefined } },
    {
      name: "authored assistant output",
      change: { assistantTexts: ["The note is already saved."] },
    },
    { name: "intentional silence", change: { assistantTexts: ["NO_REPLY"] } },
    {
      name: "unfinished tool",
      change: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    },
    {
      name: "asynchronous tool",
      change: { toolMetas: [{ toolName: "write", asyncStarted: true }] },
    },
    {
      name: "delivered reply",
      change: { didSendViaMessagingTool: true, messagingToolSentTexts: ["Note saved."] },
    },
    { name: "delivered media", change: { hasToolMediaBlockReply: true } },
    { name: "pending media", change: { toolMediaUrls: ["/tmp/note.png"] } },
    { name: "cancellation", change: { terminal: { kind: "aborted", source: "external" } } },
  ] satisfies Array<{ name: string; change: Partial<EmbeddedRunAttemptResult> }>)(
    "preserves $name instead of finalizing",
    ({ change }) => {
      const request = prepareRequest(createSettledProviderFailureAttempt(change));
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    },
  );

  it.each([
    "unattributed text",
    "earlier answer",
    "intentional silence",
    "missing context",
    "unfinished tool",
    "asynchronous tool",
    "delivered reply",
    "delivered media",
    "pending approval",
    "cancellation",
    "timeout",
    "refusal",
    "failed tool",
  ])("preserves %s after a rejected post-tool partial answer", (kind) => {
    const attempt = createSettledProviderFailureAttempt();
    const assistant = attempt.currentAttemptCompletedAssistant!;
    const errorMessage = "Provider returned an incomplete or malformed tool call";
    assistant.errorMessage = errorMessage;
    assistant.content = [{ type: "text", text: "Confirmed —\u0060\n\n" }];
    attempt.assistantTexts = ["Confirmed —\u0060\n\n"];
    attempt.terminal = { kind: "failed", source: "prompt", error: new Error(errorMessage) };
    switch (kind) {
      case "unattributed text":
        attempt.assistantTexts.push("A different completed answer.");
        break;
      case "earlier answer":
        attempt.messagesSnapshot.splice(-1, 0, {
          ...assistant,
          stopReason: "stop",
          errorMessage: undefined,
          content: [{ type: "text", text: "Already answered." }],
        });
        break;
      case "intentional silence":
        assistant.content = [{ type: "text", text: "NO_REPLY" }];
        attempt.assistantTexts = ["NO_REPLY"];
        break;
      case "missing context":
        attempt.settledTurnFinalizationContext = undefined;
        break;
      case "unfinished tool":
        attempt.itemLifecycle.activeCount = 1;
        attempt.itemLifecycle.completedCount = 0;
        break;
      case "asynchronous tool":
        attempt.toolMetas[0].asyncStarted = true;
        break;
      case "delivered reply":
        attempt.didSendViaMessagingTool = true;
        attempt.messagingToolSentTexts = ["Saved."];
        break;
      case "delivered media":
        attempt.hasToolMediaBlockReply = true;
        break;
      case "pending approval":
        attempt.didSendDeterministicApprovalPrompt = true;
        break;
      case "cancellation":
        attempt.terminal = { kind: "aborted", source: "external" };
        break;
      case "timeout":
        attempt.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
        break;
      case "refusal":
        assistant.diagnostics = [
          { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
        ];
        break;
      case "failed tool": {
        const result = attempt.messagesSnapshot.find((message) => message.role === "toolResult");
        if (result?.role === "toolResult") {
          result.isError = true;
        }
        break;
      }
    }
    expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt))).toBeNull();
  });

  it("preserves a structured provider refusal even with stale transient context", () => {
    const attempt = createSettledProviderFailureAttempt();
    const assistant = attempt.currentAttemptCompletedAssistant;
    if (!assistant) {
      throw new Error("Missing failed assistant");
    }
    assistant.diagnostics = [
      { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
    ];
    const request = prepareRequest(attempt);
    expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    expect(request.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("refused this request"),
      }),
    ]);
  });

  it("preserves a cron tool-authored silent outcome after discounting the error", () => {
    const attempt = createSettledProviderFailureAttempt();
    const result = attempt.messagesSnapshot.find((message) => message.role === "toolResult");
    if (!result || result.role !== "toolResult") {
      throw new Error("Missing settled tool result");
    }
    result.content = [{ type: "text", text: "NO_REPLY" }];
    expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt, "cron"))).toBeNull();
  });

  it.each(["unmarked error", "structured tool error", "tool presentation"])(
    "preserves %s alongside the generated provider error",
    (kind) => {
      const request = prepareRequest();
      if (kind === "tool presentation") {
        request.hasTerminalToolPresentation = true;
      } else {
        request.payloadsWithToolMedia?.push({
          text: "Explicit error",
          isError: true,
          ...(kind === "structured tool error" ? { channelData: { explicit: true } } : {}),
        });
      }
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    },
  );
});
