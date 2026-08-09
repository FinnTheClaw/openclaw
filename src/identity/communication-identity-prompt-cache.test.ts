import { describe, expect, it } from "vitest";
import { resolveCommunicationIdentityPromptCacheKey } from "./communication-identity-prompt-cache.js";

const key = (
  overrides: Partial<Parameters<typeof resolveCommunicationIdentityPromptCacheKey>[0]> = {},
) =>
  resolveCommunicationIdentityPromptCacheKey({
    agentId: "person-a",
    sessionKey: "agent:person-a:signal:default:direct:+15550000001",
    provider: "remote-llm",
    model: "moira/brain",
    ...overrides,
  });

describe("communication identity prompt cache partitioning", () => {
  it("is stable for the same identity session and model", () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^openclaw-identity-[a-f0-9]{32}$/u);
    expect(key()).not.toContain("+15550000001");
  });

  it("isolates agents even if a session key is accidentally reused", () => {
    expect(key({ agentId: "person-a" })).not.toBe(key({ agentId: "person-b" }));
  });

  it("isolates channel sessions for the same person", () => {
    expect(key()).not.toBe(
      key({ sessionKey: "agent:person-a:whatsapp:default:direct:+15550000001" }),
    );
  });

  it("isolates provider and model fallback cache state", () => {
    expect(key()).not.toBe(key({ provider: "openai" }));
    expect(key()).not.toBe(key({ model: "moira/fallback" }));
  });
});
