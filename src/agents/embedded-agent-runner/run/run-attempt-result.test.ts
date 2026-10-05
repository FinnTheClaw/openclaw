import { describe, expect, it } from "vitest";
import { createToolErrorState } from "../../tool-error-state.js";
import { buildTraceToolSummary, resolveSuccessfulToolNames } from "./run-attempt-result.js";

describe("tool result summary", () => {
  it.each([false, true])(
    "keeps failure counts independent of same-tool recovery (%s)",
    (recovered) => {
      const errors = createToolErrorState();
      errors.recordFailure({ toolName: "bash", error: "private tool failure details" });
      const successfulTool = recovered ? "bash" : "read";
      errors.recordSuccess(successfulTool);

      expect(
        buildTraceToolSummary({
          toolMetas: [
            { toolName: "bash", meta: "exit=1", isError: true },
            { toolName: "bash", meta: "exit=2", isError: true },
            { toolName: successfulTool, isError: false },
          ],
          lastToolError: errors.read().lastToolError,
        }),
      ).toEqual({
        calls: 3,
        tools: recovered ? ["bash"] : ["bash", "read"],
        failures: 2,
        ...(recovered ? {} : { unresolvedError: { toolName: "bash" } }),
      });
    },
  );
});


describe("canonical Responses tool receipts after reasoning-only continuation", () => {
  const callId = "chatcmpl-tool-9600d0db369f3e8b|fc_ce7ab020";
  function attemptWithCanonicalTurn(overrides: { resultError?: boolean; resultId?: string } = {}) {
    // Sanitized canonical seq5..8 from Alistar run7e305de3-5303-4f77-bba5-20e77f7535b9.
    // No inference or command execution: exercise the actual receipt projection.
    return {
      toolMetas: [],
      successfulNestedToolNames: [],
      messagesSnapshot: [
        { role: "user", content: "Return ALISTAR_RESPONSES_TOOL_42 after node -p 6*7." },
        {
          role: "assistant", stopReason: "toolUse",
          content: [{ type: "toolCall", id: callId, name: "exec", arguments: { command: "node -p '6*7'" } }],
        },
        {
          role: "toolResult", toolCallId: overrides.resultId ?? callId, toolName: "exec",
          content: [{ type: "text", text: "42" }], isError: overrides.resultError ?? false,
          details: { exitCode: 0 },
        },
        { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Internal continuation" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ALISTAR_RESPONSES_TOOL_42" }] },
      ],
    } as unknown as Parameters<typeof resolveSuccessfulToolNames>[0];
  }
  it("keeps the canonical successful compound-ID call after a tool-free final attempt", () => {
    expect(resolveSuccessfulToolNames(attemptWithCanonicalTurn())).toEqual(["exec"]);
  });
  it.each([
    { resultId: "different-call|fc_ce7ab020" },
    { resultError: true },
  ])("does not infer success from an unmatched or failed result: %j", (overrides) => {
    expect(resolveSuccessfulToolNames(attemptWithCanonicalTurn(overrides))).toEqual([]);
  });

  it("does not revive successful calls from a prior user turn", () => {
    const attempt = attemptWithCanonicalTurn() as Parameters<typeof resolveSuccessfulToolNames>[0] & {
      messagesSnapshot: unknown[];
    };
    (attempt as unknown as { messagesSnapshot: unknown[] }).messagesSnapshot.push({ role: "user", content: "A different turn" });
    expect(resolveSuccessfulToolNames(attempt)).toEqual([]);
  });
  it("does not pair a duplicate opaque id with a later result", () => {
    const attempt = attemptWithCanonicalTurn() as Parameters<typeof resolveSuccessfulToolNames>[0] & {
      messagesSnapshot: unknown[];
    };
    (attempt as unknown as { messagesSnapshot: unknown[] }).messagesSnapshot.splice(2, 0, {
      role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
    });
    expect(resolveSuccessfulToolNames(attempt)).toEqual([]);
  });

});
