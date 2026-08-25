// Focused CLI exit-code coverage for returned send and broadcast outcomes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const messageCommandMock = vi.fn();
vi.mock("../../../commands/message.js", () => ({
  messageCommand: messageCommandMock,
}));

vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => ({
    actions: { resolveExecutionMode: () => "local" },
  }),
}));

vi.mock("../../../globals.js", () => ({
  danger: (message: string) => message,
  setVerbose: vi.fn(),
}));

vi.mock("../../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: vi.fn(async () => {}),
}));

const exitMock = vi.fn((_code?: number): never => {
  throw new Error("exit");
});
vi.mock("../../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: exitMock },
}));

vi.mock("../../deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { createMessageCliHelpers } = await import("./helpers.js");

function sendActionResult(params: {
  deliveryStatus?: "sent" | "suppressed" | "partial_failed" | "failed";
  dryRun?: boolean;
}) {
  const sendResult = {
    channel: "discord",
    to: "channel:123",
    via: "direct" as const,
    mediaUrl: null,
    ...(params.deliveryStatus ? { deliveryStatus: params.deliveryStatus } : {}),
    ...(params.deliveryStatus === "suppressed"
      ? { suppressionReason: "cancelled_by_message_sending_hook" as const }
      : {}),
    ...(params.deliveryStatus === "failed" || params.deliveryStatus === "partial_failed"
      ? { error: "send failed" }
      : {}),
    ...(params.deliveryStatus === "partial_failed" ? { sentBeforeError: true } : {}),
  };
  return {
    kind: "send" as const,
    channel: "discord" as const,
    action: "send" as const,
    to: "channel:123",
    handledBy: "core" as const,
    payload: sendResult,
    sendResult,
    dryRun: params.dryRun ?? false,
  };
}

function broadcastActionResult(okValues: boolean[]) {
  return {
    kind: "broadcast" as const,
    channel: "discord" as const,
    action: "broadcast" as const,
    handledBy: "core" as const,
    payload: {
      results: okValues.map((ok, index) => ({
        channel: "discord" as const,
        to: `channel:${index + 1}`,
        ok,
        ...(ok ? {} : { error: "send failed" }),
      })),
    },
    dryRun: false,
  };
}

async function runAndReadExitCode(action: "send" | "broadcast"): Promise<number> {
  const helpers = createMessageCliHelpers({ help: vi.fn() } as never, "discord");
  await expect(
    helpers.runMessageAction(action, {
      channel: "discord",
      ...(action === "send"
        ? { target: "channel:123", message: "hello" }
        : { targets: ["channel:1", "channel:2"], message: "hello" }),
    }),
  ).rejects.toThrow("exit");
  const call = exitMock.mock.calls.at(-1);
  if (!call) {
    throw new Error("expected CLI exit");
  }
  const code = call[0];
  if (typeof code !== "number") {
    throw new Error("expected numeric CLI exit code");
  }
  return code;
}

describe("message CLI send outcome exit codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { label: "sent", result: sendActionResult({ deliveryStatus: "sent" }) },
    { label: "legacy", result: sendActionResult({}) },
    {
      label: "dry-run",
      result: sendActionResult({ deliveryStatus: "failed", dryRun: true }),
    },
  ])("exits 0 for a $label send", async ({ result }) => {
    messageCommandMock.mockResolvedValueOnce(result);

    expect(await runAndReadExitCode("send")).toBe(0);
  });

  it.each(["suppressed", "failed", "partial_failed"] as const)(
    "exits 1 for a %s send",
    async (deliveryStatus) => {
      messageCommandMock.mockResolvedValueOnce(sendActionResult({ deliveryStatus }));

      expect(await runAndReadExitCode("send")).toBe(1);
    },
  );

  it("exits 0 when every broadcast entry succeeded", async () => {
    messageCommandMock.mockResolvedValueOnce(broadcastActionResult([true, true]));

    expect(await runAndReadExitCode("broadcast")).toBe(0);
  });

  it("exits 1 when any broadcast entry failed", async () => {
    messageCommandMock.mockResolvedValueOnce(broadcastActionResult([true, false]));

    expect(await runAndReadExitCode("broadcast")).toBe(1);
  });
});
