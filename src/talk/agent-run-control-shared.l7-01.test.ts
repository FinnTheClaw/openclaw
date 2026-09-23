import { describe, expect, it } from "vitest";
import {
  parseRealtimeVoiceAgentControlToolArgs,
  resolveRealtimeVoiceAgentControlIntent,
} from "./agent-run-control-shared.js";

describe("L7-01 explicit provider cancellation", () => {
  it.each([
    { name: "negated cancel that", text: "don't cancel that", mode: "status", auto: false },
    { name: "negated cancel run", text: "do not cancel the run", mode: "status", auto: false },
    { name: "negated stop it", text: "don't stop it", mode: "status", auto: false },
    { name: "negated abort this", text: "never abort this", mode: "status", auto: false },
    { name: "negated kill it", text: "don't kill it", mode: "status", auto: false },
    { name: "negated end that", text: "don't end that", mode: "status", auto: false },
    {
      name: "stop-from redirect",
      text: "stop it from using the slow path",
      mode: "steer",
      auto: true,
    },
    {
      name: "negated cancel with redirect",
      text: "don't cancel that; instead use the safe path",
      mode: "steer",
      auto: true,
    },
    { name: "positive cancel that", text: "cancel that", mode: "cancel", auto: true },
    { name: "positive stop it", text: "stop it", mode: "cancel", auto: true },
  ] as const)("$name", ({ text, mode, auto }) => {
    expect(resolveRealtimeVoiceAgentControlIntent({ text, mode: "cancel" })).toMatchObject({
      mode,
      shouldAutoControl: auto,
    });
    expect(parseRealtimeVoiceAgentControlToolArgs({ text, mode: "cancel" })).toStrictEqual({
      text,
      mode,
    });
  });
});
