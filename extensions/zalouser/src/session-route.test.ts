import { describe, expect, it } from "vitest";
import {
  parseZalouserOutboundTarget,
  resolveZalouserOutboundSessionRoute,
} from "./session-route.js";

describe("resolveZalouserOutboundSessionRoute", () => {
  it("does not claim store-dependent DM migration routes as exact", () => {
    const route = resolveZalouserOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "user:u-123",
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it("accepts canonical group routes", () => {
    const route = resolveZalouserOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "group:g-123",
    });

    expect(route?.recipientSessionExact).toBe(true);
  });

  it.each([
    {
      id: "Z01-01",
      target: "group:group-123",
      to: "zalouser:group:group-123",
      isGroup: true,
      threadId: "group-123",
    },
    {
      id: "Z01-02",
      target: "group:g-123",
      to: "zalouser:group:g-123",
      isGroup: true,
      threadId: "g-123",
    },
    {
      id: "Z01-03",
      target: "g:group-123",
      to: "zalouser:group:group-123",
      isGroup: true,
      threadId: "group-123",
    },
    {
      id: "Z01-04",
      target: "zlu:group:group-123",
      to: "zalouser:group:group-123",
      isGroup: true,
      threadId: "group-123",
    },
    {
      id: "Z01-05",
      target: "zalouser:GROUP:MiXeD",
      to: "zalouser:group:MiXeD",
      isGroup: true,
      threadId: "MiXeD",
    },
    { id: "Z01-06", target: "user:u-123", to: "zalouser:u-123", isGroup: false, threadId: "u-123" },
    { id: "Z01-07", target: "dm:u-123", to: "zalouser:u-123", isGroup: false, threadId: "u-123" },
    { id: "Z01-08", target: "g-123", to: "zalouser:group:g-123", isGroup: true, threadId: "g-123" },
    { id: "Z01-09", target: "group:", to: null, isGroup: null, threadId: null },
    {
      id: "Z01-10",
      target: "bare-123",
      to: "zalouser:bare-123",
      isGroup: false,
      threadId: "bare-123",
    },
  ])("$id preserves outbound target kind through routing", ({ target, to, isGroup, threadId }) => {
    const route = resolveZalouserOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target,
    });
    if (to === null) {
      expect(route).toBeNull();
      return;
    }
    expect(route?.to).toBe(to);
    expect(parseZalouserOutboundTarget(route!.to)).toEqual({ isGroup, threadId });
  });
});
