// Consult question tests cover question extraction for agent consultation.
import { describe, expect, it } from "vitest";
import {
  matchRealtimeVoiceConsultQuestions,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
} from "./consult-question.js";

describe("realtime voice consult question helpers", () => {
  it("reads common provider question fields", () => {
    expect(readRealtimeVoiceConsultQuestion({ question: " check status " })).toBe("check status");
    expect(readRealtimeVoiceConsultQuestion({ prompt: "look up docs" })).toBe("look up docs");
    expect(readRealtimeVoiceConsultQuestion({ query: "find logs" })).toBe("find logs");
    expect(readRealtimeVoiceConsultQuestion({ task: "summarize" })).toBe("summarize");
    expect(readRealtimeVoiceConsultQuestion({ question: "   " })).toBeUndefined();
  });

  it("matches exact, contained, and token-overlap questions conservatively", () => {
    expect(matchRealtimeVoiceConsultQuestions("Can you check this?", "check this")).toBe(true);
    expect(
      matchRealtimeVoiceConsultQuestions(
        "Send me a Discord message after checking the branch",
        "check branch and send Discord message",
      ),
    ).toBe(true);
    expect(matchRealtimeVoiceConsultQuestions("check this branch", "restart the server")).toBe(
      false,
    );
    expect(matchRealtimeVoiceConsultQuestions("restart server", "check server")).toBe(false);
  });

  it.each([
    { id: "F01-01", left: "delete file", right: "undelete file", expected: false },
    { id: "F01-02", left: "delete file", right: "redeleted file", expected: false },
    { id: "F01-03", left: "delete file", right: "delete files", expected: false },
    { id: "F01-04", left: "delete file", right: "delete file2", expected: false },
    { id: "F01-05", left: "write report", right: "rewrite report", expected: false },
    { id: "F01-06", left: "\u00e9crire rapport", right: "r\u00e9crire rapport", expected: false },
    { id: "F01-07", left: "delete file", right: "please delete file", expected: true },
    { id: "F01-08", left: "delete file", right: "delete file now", expected: true },
    { id: "F01-09", left: "Delete-file?", right: "please: delete file!", expected: true },
    {
      id: "F01-10",
      left: "Send me a Discord message after checking the branch",
      right: "check branch and send Discord message",
      expected: true,
    },
  ])("$id keeps consult question matching at phrase boundaries", ({ left, right, expected }) => {
    expect(matchRealtimeVoiceConsultQuestions(left, right)).toBe(expected);
  });

  it("extracts bounded speakable text from tool results", () => {
    expect(readSpeakableRealtimeVoiceToolResult({ text: " Answer " })).toBe("Answer");
    expect(readSpeakableRealtimeVoiceToolResult({ result: "Result" })).toBe("Result");
    expect(readSpeakableRealtimeVoiceToolResult("Direct")).toBe("Direct");
    expect(
      readSpeakableRealtimeVoiceToolResult(
        { text: "abcdefghijklmnopqrstuvwxyz" },
        { maxChars: 24 },
      ),
    ).toBe("abcdefgh [truncated]");
  });

  it("does not split a boundary emoji in truncated speakable text", () => {
    const result = readSpeakableRealtimeVoiceToolResult(
      { text: `${"a".repeat(7)}😀${"b".repeat(20)}` },
      { maxChars: 23 },
    );

    expect(result).toBe(`${"a".repeat(7)} [truncated]`);
    expect(result).toContain("[truncated]");
  });
});
