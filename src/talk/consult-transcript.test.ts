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

  it.each([
    "I'll be right back. See you guys. Bye-bye.",
    "Thanks and goodbye.",
    "All right, thanks and goodbye.",
    "Goodbye, take care",
    "Thank you very much and goodbye.",
    "Okay, goodbye and have a nice weekend.",
    "Bye for now, folks.",
    "See you next week.",
    "See you on Monday.",
    "I'll be right back in a minute.",
    "I will be back in a few minutes.",
    "I’ll be right back. Bye.",
    "Good bye.",
    "Good-bye.",
  ])("skips complete closing: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBe("non-actionable-closing");
  });

  it.each([
    "Write a goodbye email to Sam",
    "I'll be right back, please check the build.",
    'Explain the code `print("goodbye")`.',
    "can you say goodbye?",
    "what changed in CI?",
    "Goodbye, everyone, please check the build.",
    "Thanks, goodbye. Send me the report.",
    'Translate "goodbye" into French.',
    "Thank you.",
  ])("keeps actionable transcript: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBeUndefined();
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
