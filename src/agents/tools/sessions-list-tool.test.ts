// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

type SessionsListDetails = {
  sessions?: Array<{
    deliveryContext?: {
      accountId?: string;
      channel?: string;
      threadId?: string | number;
      to?: string;
    };
    elevatedLevel?: string;
    effectiveFastMode?: boolean | "auto";
    effectiveFastModeSource?: "session" | "agent" | "config" | "default";
    fastMode?: boolean | "auto";
    fastAutoOnSeconds?: number;
    archived?: boolean;
    archivedAt?: number;
    pinned?: boolean;
    pinnedAt?: number;
    kind?: "main" | "group" | "cron" | "hook" | "node" | "other";
    reasoningLevel?: string;
    responseUsage?: string;
    status?: string;
    thinkingLevel?: string;
    verboseLevel?: string;
  }>;
};

function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
  });

  it("keeps deliveryContext.threadId in sessions_list results", async () => {
    // Thread/topic ids are required for channel-specific follow-up routing, so
    // list results must preserve both string and numeric variants.
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(Object.hasOwn(details.sessions?.[0] ?? {}, "effectiveFastMode")).toBe(false);
    expect(details.sessions?.[1]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:topic",
      accountId: "acct-2",
      threadId: 271,
    });
  });

  it("keeps numeric deliveryContext.threadId in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:telegram:group:-100123:topic:99",
              kind: "group",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
                threadId: 99,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-2", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      threadId: 99,
    });
  });

  it("keeps live session setting metadata in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session?.thinkingLevel).toBe("high");
    expect(session?.fastMode).toBe("auto");
    expect(session?.effectiveFastMode).toBe("auto");
    expect(session?.effectiveFastModeSource).toBe("config");
    expect(session?.fastAutoOnSeconds).toBe(30);
    expect(session?.verboseLevel).toBe("on");
    expect(session?.reasoningLevel).toBe("deep");
    expect(session?.elevatedLevel).toBe("on");
    expect(session?.responseUsage).toBe("full");
  });

  it("preserves blocked subagent presentation status", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:blocked",
          kind: "direct",
          sessionId: "sess-blocked",
          status: "blocked",
        },
      ],
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-blocked", {});

    expect(getSessionsListDetails(result).sessions?.[0]?.status).toBe("blocked");
  });

  it("limits session kind arguments to the documented classification values", () => {
    const tool = createSessionsListTool({ config: {} as never });

    expect(
      Value.Check(tool.parameters, { kinds: ["main", "group", "cron", "hook", "node", "other"] }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { kinds: ["unknown"] })).toBe(false);
    expect(Value.Check(tool.parameters, { kinds: ["   "] })).toBe(false);
    expect(Value.Check(tool.parameters, { kinds: ["MAIN"] })).toBe(false);
    expect(Value.Check(tool.parameters, { kinds: "main" })).toBe(false);
  });

  it.each([
    { name: "omitted", params: {}, expected: ["main", "group", "cron", "hook", "node", "other"] },
    {
      name: "empty array",
      params: { kinds: [] },
      expected: ["main", "group", "cron", "hook", "node", "other"],
    },
    {
      name: "empty scalar",
      params: { kinds: "" },
      expected: ["main", "group", "cron", "hook", "node", "other"],
    },
    { name: "unknown-only", params: { kinds: ["unknown"] }, expected: [] },
    { name: "whitespace-only", params: { kinds: ["   "] }, expected: [] },
    { name: "unknown scalar", params: { kinds: "unknown" }, expected: [] },
    { name: "whitespace scalar", params: { kinds: "   " }, expected: [] },
    { name: "known scalar", params: { kinds: "MAIN" }, expected: ["main"] },
    { name: "known array", params: { kinds: ["MAIN"] }, expected: ["main"] },
    {
      name: "mixed known and unknown",
      params: { kinds: ["unknown", "MAIN"] },
      expected: ["main"],
    },
    { name: "mixed string and number", params: { kinds: ["MAIN", 7] }, expected: ["main"] },
    { name: "non-string array", params: { kinds: [7] }, expected: [] },
    { name: "object", params: { kinds: {} }, expected: [] },
    { name: "null", params: { kinds: null }, expected: [] },
    { name: "number", params: { kinds: 42 }, expected: [] },
    { name: "boolean", params: { kinds: true }, expected: [] },
  ])("never broadens the $name session kind filter", async ({ params, expected }) => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "main", kind: "direct" },
        { key: "slack:channel:team-room", kind: "group" },
        { key: "cron:nightly", kind: "direct" },
        { key: "hook:deploy", kind: "direct" },
        { key: "node-device", kind: "direct" },
        { key: "agent:main:subagent:other", kind: "direct" },
      ],
    });

    const result = await createSessionsListTool({ config: {} as never }).execute(
      "filter-kinds",
      params,
    );

    expect(getSessionsListDetails(result).sessions?.map((session) => session.kind)).toEqual(
      expected,
    );
  });

  it("requests archived sessions and keeps management metadata", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:dashboard:archived",
          kind: "direct",
          archived: true,
          archivedAt: 20,
          pinned: false,
        },
      ],
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-archived", { archived: true });

    expect(mocks.gatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.list",
        params: expect.objectContaining({ archived: true }),
      }),
    );
    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({
      archived: true,
      archivedAt: 20,
      pinned: false,
    });
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: {} as never });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
