import { describe, expect, it } from "vitest";
import { resolveFoundryTargetProfileId } from "./shared.js";

type FoundryConfig = Parameters<typeof resolveFoundryTargetProfileId>[0];
const foundry = { provider: "microsoft-foundry", mode: "api_key" };
const foreign = { provider: "other-provider", mode: "api_key" };

describe("checkpoint-90 Foundry ordered profile membership", () => {
  it.each([
    { name: "valid-first-ordered", profiles: { good: foundry }, order: ["good"], expected: "good" },
    {
      name: "valid-second-after-stale",
      profiles: { good: foundry },
      order: ["stale", "good"],
      expected: "good",
    },
    {
      name: "foreign-provider-before-valid",
      profiles: { good: foundry, other: foreign },
      order: ["other", "good"],
      expected: "good",
    },
    {
      name: "only-stale-with-single-valid-fallback",
      profiles: { good: foundry },
      order: ["stale"],
      expected: "good",
    },
    {
      name: "only-foreign-with-single-valid-fallback",
      profiles: { good: foundry, other: foreign },
      order: ["other"],
      expected: "good",
    },
    {
      name: "no-order-single-valid",
      profiles: { good: foundry },
      order: undefined,
      expected: "good",
    },
    {
      name: "no-order-two-valid",
      profiles: { good: foundry, second: foundry },
      order: undefined,
      expected: undefined,
    },
    {
      name: "ordered-valid-among-two",
      profiles: { good: foundry, second: foundry },
      order: ["second"],
      expected: "second",
    },
    {
      name: "empty-order-entry",
      profiles: { good: foundry },
      order: ["", "good"],
      expected: "good",
    },
    {
      name: "no-Foundry-profile",
      profiles: { other: foreign },
      order: ["other"],
      expected: undefined,
    },
  ])("$name", ({ profiles, order, expected }) => {
    const config = {
      auth: {
        profiles,
        ...(order ? { order: { "microsoft-foundry": order } } : {}),
      },
    } as FoundryConfig;
    expect(resolveFoundryTargetProfileId(config)).toBe(expected);
  });
});
