// Consult transcript tests cover transcript formatting for talk consults.
import { describe, expect, it } from "vitest";
import { classifySkippableRealtimeVoiceConsultTranscript } from "./consult-transcript.js";

describe("realtime voice consult transcript classification", () => {
  it("skips empty and incomplete transcripts", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("  ")).toBe("empty");
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check...")).toBe(
      "incomplete-transcript",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check…")).toBe(
      "incomplete-transcript",
    );
  });

  it("skips likely trailing fragments", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("tell me about")).toBe(
      "trailing-fragment",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("ship it so")).toBe("trailing-fragment");
  });

  it("skips non-actionable closings unless phrased as a question", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("I'll be right back")).toBe(
      "non-actionable-closing",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("goodbye for now")).toBe(
      "non-actionable-closing",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you say goodbye?")).toBeUndefined();
  });

  it("keeps actionable transcripts", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("what changed in CI?")).toBeUndefined();
  });
});

describe("R7-L07-10 standalone closing versus requested action", () => {
  it.each<[string, string, "non-actionable-closing" | undefined]>([
    ["consult-send-bye", "Send Alice a bye message", undefined],
    ["consult-draft-goodbye", "Draft a goodbye note to Bob", undefined],
    ["consult-reminder-see-you", "Remind me to say see you after the meeting", undefined],
    ["consult-back-with-action", "I'll be right back, but send Alice a bye message", undefined],
    ["consult-question-goodbye", "Can you say goodbye?", undefined],
    ["consult-plain-bye", "Bye", "non-actionable-closing"],
    ["consult-goodbye-for-now", "Goodbye for now", "non-actionable-closing"],
    ["consult-see-you-later", "See you later", "non-actionable-closing"],
    ["consult-ok-bye", "Okay, bye", "non-actionable-closing"],
    ["consult-back-soon", "I will be right back", "non-actionable-closing"],
  ])("%s", (_name, transcript, expected) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(transcript)).toBe(expected);
  });
});
