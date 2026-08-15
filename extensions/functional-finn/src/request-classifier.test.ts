import { describe, expect, it } from "vitest";
import { classifyFunctionalFinnRequest } from "./request-classifier.js";

describe("Functional Finn request classification", () => {
  it.each(["hi", "Thanks!", "okay", "👍", "How are you?"])(
    "keeps conversational input lightweight: %s",
    (prompt) => {
      expect(classifyFunctionalFinnRequest(prompt)).toBe("trivial");
    },
  );

  it.each([
    "Please inspect the service and fix it",
    "Remember that the host changed",
    "What version is installed?",
    "Write a report",
    "Thanks, now deploy it",
  ])("admits substantive work: %s", (prompt) => {
    expect(classifyFunctionalFinnRequest(prompt)).toBe("substantive");
  });
});
