import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async () => ({ payloads: [] as unknown[] })),
  loggerInfo: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      info: mocks.loggerInfo,
    }),
  };
});
vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({ agent: { runCommandFromIngress: mocks.run } }),
}));

import { runDiscordVoiceAgentTurn } from "./ingress.js";

const context = { senderIsOwner: false, speakerLabel: "Guest" };
const shared = {
  entry: {
    guildId: "guild-1",
    channelId: "channel-1",
    voiceSessionKey: "voice-1",
    route: { agentId: "main", sessionKey: "agent:main:voice:1" },
  } as never,
  accountId: "default",
  userId: "speaker-1",
  message: "Please answer",
  cfg: {} as never,
  discordConfig: {} as never,
  runtime: { log: vi.fn(), error: vi.fn() } as never,
  context,
  fetchGuildName: vi.fn(async () => "Guild"),
  speakerContext: {} as never,
};

describe("CH06 Discord voice speakable payloads", () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.loggerInfo.mockReset();
  });
  it.each([
    { id: "P01 visible only", payloads: [{ text: "answer" }], expected: "answer" },
    { id: "P02 reasoning only", payloads: [{ text: "private", isReasoning: true }], expected: "" },
    { id: "P03 error only", payloads: [{ text: "failure", isError: true }], expected: "" },
    {
      id: "P04 reasoning then visible",
      payloads: [{ text: "private", isReasoning: true }, { text: "answer" }],
      expected: "answer",
    },
    {
      id: "P05 visible then error",
      payloads: [{ text: "answer" }, { text: "failure", isError: true }],
      expected: "answer",
    },
    {
      id: "P06 visible order",
      payloads: [{ text: "first" }, { text: "second" }],
      expected: "first\nsecond",
    },
    { id: "P07 whitespace", payloads: [{ text: "  " }, { text: "answer" }], expected: "answer" },
    { id: "P08 media only", payloads: [{ mediaUrl: "https://example.test/audio" }], expected: "" },
    { id: "P09 null unknown", payloads: [null, 5, { other: true }], expected: "" },
    {
      id: "P10 diagnostic-only categories",
      payloads: [
        { text: "private", isReasoning: true },
        { text: "failure", isError: true },
        { mediaUrl: "https://example.test/audio" },
      ],
      expected: "",
      diagnostic: true,
    },
  ] as Array<{ id: string; payloads: unknown[]; expected: string; diagnostic?: boolean }>)(
    "$id",
    async ({ payloads, expected, diagnostic }) => {
      mocks.run.mockResolvedValue({ payloads });
      const result = await runDiscordVoiceAgentTurn(shared);
      expect(result?.text).toBe(expected);
      expect(mocks.run).toHaveBeenCalledTimes(1);
      if (diagnostic) {
        expect(mocks.loggerInfo).toHaveBeenCalledWith(
          expect.stringContaining("reasoningPayloads=1 errorPayloads=1 mediaPayloads=1"),
        );
      }
    },
  );
});
