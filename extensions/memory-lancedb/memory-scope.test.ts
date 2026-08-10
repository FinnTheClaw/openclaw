import { describe, expect, it } from "vitest";
import {
  isMemoryScopeCompatible,
  memoryScopeMetadata,
  resolveTrustedMemoryScope,
} from "./memory-scope.js";

describe("trusted memory scope", () => {
  const base = {
    agentId: "person-owner",
    workspaceDir: "/srv/openclaw/workspaces/person-owner",
    channel: "signal",
    accountId: "default",
    conversationId: "fake-contact-9113",
    sessionKey: "agent:person-owner:signal:default:direct:fake-contact-9113",
  };

  it("keeps one principal stable while isolating conversations and sessions", () => {
    const first = resolveTrustedMemoryScope(base);
    const repeated = resolveTrustedMemoryScope(base);
    const otherContact = resolveTrustedMemoryScope({
      ...base,
      conversationId: "fake-contact-7255",
      sessionKey: "agent:person-owner:signal:default:direct:fake-contact-7255",
    });
    const nextSession = resolveTrustedMemoryScope({
      ...base,
      sessionKey: `${base.sessionKey}:next`,
    });

    expect(repeated).toEqual(first);
    expect(otherContact.storageAgentId).toBe(first.storageAgentId);
    expect(otherContact.conversationScope).not.toBe(first.conversationScope);
    expect(nextSession.conversationScope).not.toBe(first.conversationScope);
    expect(nextSession.principalScope).toBe(first.principalScope);
  });

  it("separates principals even when channel-local identifiers collide", () => {
    const first = resolveTrustedMemoryScope(base);
    const second = resolveTrustedMemoryScope({
      ...base,
      agentId: "person-two",
      workspaceDir: "/srv/openclaw/workspaces/person-two",
    });
    expect(second.storageAgentId).not.toBe(first.storageAgentId);
    expect(second.conversationScope).not.toBe(first.conversationScope);
    expect(second.principalScope).not.toBe(first.principalScope);
  });

  it("never places raw identifiers or workspace paths in persisted metadata", () => {
    const scope = resolveTrustedMemoryScope(base);
    const metadata = memoryScopeMetadata(scope, "direct_user");
    const serialized = JSON.stringify({ scope, metadata });
    expect(serialized).not.toContain("fake-contact-9113");
    expect(serialized).not.toContain("person-owner");
    expect(serialized).not.toContain("/srv/openclaw/workspaces");
    expect(isMemoryScopeCompatible(scope, metadata)).toBe(true);
  });

  it("fails closed when a channel event lacks conversation or session identity", () => {
    expect(() =>
      resolveTrustedMemoryScope({
        agentId: "person",
        workspaceDir: "/srv/person",
        channel: "signal",
        sessionKey: "agent:person:signal:default:direct:fake",
      }),
    ).toThrow("without a conversation identity");
    expect(() =>
      resolveTrustedMemoryScope({
        agentId: "person",
        workspaceDir: "/srv/person",
        channel: "signal",
        conversationId: "fake",
      }),
    ).toThrow("without a canonical session identity");
  });
});
