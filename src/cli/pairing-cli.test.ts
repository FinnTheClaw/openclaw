// Pairing CLI tests cover pairing command registration and pairing status output.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { registerPairingCli } from "./pairing-cli.js";

const mocks = vi.hoisted(() => {
  class CommunicationIdentityPhoneRequiredError extends Error {
    readonly code = "COMMUNICATION_IDENTITY_PHONE_REQUIRED";
    readonly channel: string;

    constructor(channel: string) {
      super(
        `Phone-backed channel "${channel}" requires a canonical E.164 phone identity. ` +
          "Supply --identity-phone when the channel exposes only an opaque UUID/JID.",
      );
      this.name = "CommunicationIdentityPhoneRequiredError";
      this.channel = channel;
    }
  }
  return {
    CommunicationIdentityPhoneRequiredError,
    listChannelPairingRequests: vi.fn(),
    approveChannelPairingCode: vi.fn(),
    notifyPairingApproved: vi.fn(),
    ensureCommunicationIdentityForPairing: vi.fn(),
    listCommunicationIdentities: vi.fn(),
    reconcileCommunicationIdentityConfig: vi.fn(),
    setCommunicationAdminPhone: vi.fn(),
    adminQuestion: vi.fn(),
    adminPromptClose: vi.fn(),
    readConfigFileSnapshotForWrite: vi.fn(),
    replaceConfigFile: vi.fn(),
    normalizeChannelId: vi.fn((raw: string) => {
      if (!raw) {
        return null;
      }
      if (raw === "imsg") {
        return "imessage";
      }
      if (["telegram", "discord", "imessage"].includes(raw)) {
        return raw;
      }
      return null;
    }),
    getPairingAdapter: vi.fn((channel: string) => ({
      idLabel: pairingIdLabels[channel] ?? "userId",
    })),
    listPairingChannels: vi.fn(() => ["telegram", "discord", "imessage"]),
  };
});

const {
  CommunicationIdentityPhoneRequiredError,
  listChannelPairingRequests,
  approveChannelPairingCode,
  notifyPairingApproved,
  ensureCommunicationIdentityForPairing,
  listCommunicationIdentities,
  reconcileCommunicationIdentityConfig,
  setCommunicationAdminPhone,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  normalizeChannelId,
  getPairingAdapter,
  listPairingChannels,
} = mocks;

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: mocks.adminQuestion,
    close: mocks.adminPromptClose,
  }),
}));

const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};

vi.mock("../pairing/pairing-store.js", () => ({
  listChannelPairingRequests: mocks.listChannelPairingRequests,
  approveChannelPairingCode: mocks.approveChannelPairingCode,
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  listPairingChannels: mocks.listPairingChannels,
  notifyPairingApproved: mocks.notifyPairingApproved,
  getPairingAdapter: mocks.getPairingAdapter,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../identity/communication-identities.js", () => ({
  CommunicationIdentityPhoneRequiredError: mocks.CommunicationIdentityPhoneRequiredError,
  ensureCommunicationIdentityForPairing: mocks.ensureCommunicationIdentityForPairing,
  listCommunicationIdentities: mocks.listCommunicationIdentities,
  normalizeCommunicationPhone: (value: unknown) =>
    typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value.trim()) ? value.trim() : null,
  reconcileCommunicationIdentityConfig: mocks.reconcileCommunicationIdentityConfig,
  setCommunicationAdminPhone: mocks.setCommunicationAdminPhone,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({}),
  loadConfig: vi.fn().mockReturnValue({}),
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
}));

describe("pairing cli", () => {
  beforeEach(() => {
    listChannelPairingRequests.mockClear();
    listChannelPairingRequests.mockResolvedValue([]);
    approveChannelPairingCode.mockClear();
    approveChannelPairingCode.mockImplementation(
      async (params: {
        beforeAllow?: (entry: {
          id: string;
          code: string;
          createdAt: string;
          lastSeenAt: string;
        }) => Promise<void>;
      }) => {
        const entry = {
          id: "123",
          code: "ABCDEFGH",
          createdAt: "2026-01-08T00:00:00Z",
          lastSeenAt: "2026-01-08T00:00:00Z",
        };
        await params.beforeAllow?.(entry);
        return { id: "123", entry };
      },
    );
    notifyPairingApproved.mockClear();
    readConfigFileSnapshotForWrite.mockClear();
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: "{}",
        parsed: {},
        valid: true,
        issues: [],
        legacyIssues: [],
        sourceConfig: {},
        runtimeConfig: {},
      },
      writeOptions: {},
    });
    replaceConfigFile.mockClear();
    replaceConfigFile.mockResolvedValue(undefined);
    normalizeChannelId.mockClear();
    getPairingAdapter.mockClear();
    listPairingChannels.mockClear();
    notifyPairingApproved.mockResolvedValue(undefined);
    ensureCommunicationIdentityForPairing.mockReset();
    ensureCommunicationIdentityForPairing.mockResolvedValue({
      identity: {
        id: "id-aaaaaaaaaaaaaaaaaaaaaaaa",
        canonicalKind: "channel-peer",
        memberAgentId: "person-aaaaaaaaaaaaaaaa",
        workspace: "/tmp/member/workspace",
        agentDir: "/tmp/member/agent",
        createdAt: "2026-01-08T00:00:00Z",
        updatedAt: "2026-01-08T00:00:00Z",
        endpoints: [],
      },
      created: true,
      endpointAdded: true,
      bootstrappedAdmin: false,
      isAdmin: false,
    });
    listCommunicationIdentities.mockReset();
    listCommunicationIdentities.mockResolvedValue({ adminIdentityId: null, identities: [] });
    reconcileCommunicationIdentityConfig.mockReset();
    reconcileCommunicationIdentityConfig.mockResolvedValue({ identities: {} });
    setCommunicationAdminPhone.mockReset();
    mocks.adminQuestion.mockReset();
    mocks.adminPromptClose.mockReset();
  });

  function createProgram() {
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    return program;
  }

  async function runPairing(args: string[]) {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  }

  function mockApprovedPairing() {
    approveChannelPairingCode.mockImplementationOnce(
      async (params: {
        beforeAllow?: (entry: {
          id: string;
          code: string;
          createdAt: string;
          lastSeenAt: string;
        }) => Promise<void>;
      }) => {
        const entry = {
          id: "123",
          code: "ABCDEFGH",
          createdAt: "2026-01-08T00:00:00Z",
          lastSeenAt: "2026-01-08T00:00:00Z",
        };
        await params.beforeAllow?.(entry);
        return { id: "123", entry };
      },
    );
  }

  it("evaluates pairing channels when registering the CLI (not at import)", () => {
    expect(listPairingChannels).not.toHaveBeenCalled();

    createProgram();

    expect(listPairingChannels).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "telegram ids",
      channel: "telegram",
      id: "123",
      label: "telegramUserId",
      meta: { username: "peter" },
    },
    {
      name: "discord ids",
      channel: "discord",
      id: "999",
      label: "discordUserId",
      meta: { tag: "Ada#0001" },
    },
  ])("labels $name correctly", async ({ channel, id, label, meta }) => {
    listChannelPairingRequests.mockResolvedValueOnce([
      {
        id,
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "list", "--channel", channel]);
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain(label);
      expect(output).toContain(id);
    } finally {
      log.mockRestore();
    }
  });

  it("accepts channel as positional for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "telegram"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram");
  });

  it("forwards --account for list", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "--channel", "telegram", "--account", "yy"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("telegram", process.env, "yy");
  });

  it("normalizes channel aliases", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "imsg"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("imsg");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("imessage");
  });

  it("accepts extension channels outside the registry", async () => {
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list", "zalo"]);

    expect(normalizeChannelId).toHaveBeenCalledWith("zalo");
    expect(listChannelPairingRequests).toHaveBeenCalledWith("zalo");
  });

  it("defaults list to the sole available channel", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    listChannelPairingRequests.mockResolvedValueOnce([]);

    await runPairing(["pairing", "list"]);

    expect(listChannelPairingRequests).toHaveBeenCalledWith("slack");
  });

  it("redirects to openclaw devices when no pairing channels are configured", async () => {
    listPairingChannels.mockReturnValueOnce([]);

    const error = await runPairing(["pairing", "list"]).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("openclaw devices");
    // Must not leak the empty enum that originally read like a bug.
    expect(message).not.toContain("expected one of: )");
    expect(message).not.toContain("()");
    expect(listChannelPairingRequests).not.toHaveBeenCalled();
  });

  it("lists supported channels when one is required but omitted", async () => {
    // Multiple channels configured (default mock) + no channel argument.
    await expect(runPairing(["pairing", "list"])).rejects.toThrow(
      "expected one of: telegram, discord, imessage",
    );
  });

  it("provisions an isolated identity before ordinary pairing approval", async () => {
    mockApprovedPairing();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "telegram", "ABCDEFGH"]);

      expect(approveChannelPairingCode).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          code: "ABCDEFGH",
          beforeAllow: expect.any(Function),
        }),
      );
      expect(ensureCommunicationIdentityForPairing).toHaveBeenCalledWith({
        channel: "telegram",
        accountId: undefined,
        peerId: "123",
        identityPhone: undefined,
      });
      expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(log.mock.calls).toHaveLength(2);
      expect(log.mock.calls[0]?.[0]).toBe(
        `${theme.success("Approved")} ${theme.muted("telegram")} sender ${theme.command("123")}.`,
      );
      expect(log.mock.calls[1]?.[0]).toContain("Isolated identity ready");
    } finally {
      log.mockRestore();
    }
  });

  it("forwards an explicit canonical phone for cross-channel rebinding", async () => {
    mockApprovedPairing();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing([
        "pairing",
        "approve",
        "telegram",
        "ABCDEFGH",
        "--identity-phone",
        "+15125550123",
      ]);
      expect(ensureCommunicationIdentityForPairing).toHaveBeenCalledWith(
        expect.objectContaining({ identityPhone: "+15125550123" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("uses provider-supplied phone metadata for an opaque channel peer", async () => {
    approveChannelPairingCode.mockImplementationOnce(
      async (params: {
        beforeAllow?: (entry: {
          id: string;
          code: string;
          createdAt: string;
          lastSeenAt: string;
          meta?: Record<string, string>;
        }) => Promise<void>;
      }) => {
        const entry = {
          id: "signal-uuid-opaque",
          code: "ABCDEFGH",
          createdAt: "2026-01-08T00:00:00Z",
          lastSeenAt: "2026-01-08T00:00:00Z",
          meta: { e164: "+15125550123" },
        };
        await params.beforeAllow?.(entry);
        return { id: entry.id, entry };
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "signal", "ABCDEFGH"]);
      expect(ensureCommunicationIdentityForPairing).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "signal",
          peerId: "signal-uuid-opaque",
          identityPhone: "+15125550123",
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("prompts on the host terminal and retries opaque Signal pairing atomically", async () => {
    const phone = "+15125550123";
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    mocks.adminQuestion.mockResolvedValueOnce(phone).mockResolvedValueOnce(phone);
    ensureCommunicationIdentityForPairing.mockImplementation(
      async (params: { identityPhone?: string }) => {
        if (!params.identityPhone) {
          throw new CommunicationIdentityPhoneRequiredError("signal");
        }
        return {
          identity: {
            id: "id-aaaaaaaaaaaaaaaaaaaaaaaa",
            canonicalKind: "phone",
            phone,
            memberAgentId: "person-aaaaaaaaaaaaaaaa",
            workspace: "/tmp/member/workspace",
            agentDir: "/tmp/member/agent",
            createdAt: "2026-01-08T00:00:00Z",
            updatedAt: "2026-01-08T00:00:00Z",
            endpoints: [],
          },
          created: true,
          endpointAdded: true,
          bootstrappedAdmin: false,
          isAdmin: false,
        };
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runPairing(["pairing", "approve", "signal", "ABCDEFGH"]);
      expect(approveChannelPairingCode).toHaveBeenCalledTimes(2);
      expect(ensureCommunicationIdentityForPairing).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ identityPhone: undefined }),
      );
      expect(ensureCommunicationIdentityForPairing).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ identityPhone: phone }),
      );
      expect(mocks.adminQuestion).toHaveBeenCalledTimes(2);
      expect(mocks.adminPromptClose).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("keeps opaque phone-backed pairing fail-closed outside a host terminal", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    ensureCommunicationIdentityForPairing.mockRejectedValueOnce(
      new CommunicationIdentityPhoneRequiredError("signal"),
    );
    try {
      await expect(runPairing(["pairing", "approve", "signal", "ABCDEFGH"])).rejects.toThrow(
        "interactive host terminal",
      );
      expect(approveChannelPairingCode).toHaveBeenCalledTimes(1);
      expect(mocks.adminQuestion).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("does not approve an opaque Signal sender when phone confirmation mismatches", async () => {
    const phone = "+15125550123";
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    mocks.adminQuestion.mockResolvedValueOnce(phone).mockResolvedValueOnce("+15125550124");
    ensureCommunicationIdentityForPairing.mockRejectedValueOnce(
      new CommunicationIdentityPhoneRequiredError("signal"),
    );
    try {
      await expect(runPairing(["pairing", "approve", "signal", "ABCDEFGH"])).rejects.toThrow(
        "confirmation did not match",
      );
      expect(approveChannelPairingCode).toHaveBeenCalledTimes(1);
      expect(mocks.adminPromptClose).toHaveBeenCalledTimes(1);
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("rejects an invalid explicit pairing phone before touching stores", async () => {
    await expect(
      runPairing(["pairing", "approve", "signal", "ABCDEFGH", "--identity-phone", "not-a-phone"]),
    ).rejects.toThrow("must be a valid E.164 number");
    expect(approveChannelPairingCode).not.toHaveBeenCalled();
  });

  it("forwards --account for approve", async () => {
    mockApprovedPairing();

    await runPairing([
      "pairing",
      "approve",
      "--channel",
      "telegram",
      "--account",
      "yy",
      "ABCDEFGH",
    ]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        code: "ABCDEFGH",
        accountId: "yy",
        beforeAllow: expect.any(Function),
      }),
    );
  });

  it("defaults approve to the sole available channel when only code is provided", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    mockApprovedPairing();

    await runPairing(["pairing", "approve", "ABCDEFGH"]);

    expect(approveChannelPairingCode).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        code: "ABCDEFGH",
        beforeAllow: expect.any(Function),
      }),
    );
  });

  it("reconciles managed identities through the host CLI", async () => {
    await runPairing(["pairing", "identities", "reconcile"]);
    expect(reconcileCommunicationIdentityConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects admin transfer from a non-interactive agent process", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      await expect(runPairing(["pairing", "admin", "set", "+15125550123"])).rejects.toThrow(
        "interactive host terminal",
      );
      expect(setCommunicationAdminPhone).not.toHaveBeenCalled();
      expect(mocks.adminQuestion).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("transfers admin after exact confirmation in an interactive host terminal", async () => {
    const phone = "+15125550123";
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    mocks.adminQuestion.mockResolvedValue(phone);
    setCommunicationAdminPhone.mockResolvedValue({ id: "id-new-admin" });
    try {
      await runPairing(["pairing", "admin", "set", phone]);
      expect(mocks.adminQuestion).toHaveBeenCalledWith(expect.stringContaining(phone));
      expect(setCommunicationAdminPhone).toHaveBeenCalledWith({ phone });
      expect(mocks.adminPromptClose).toHaveBeenCalledTimes(1);
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      }
    }
  });

  it("keeps approve usage error when multiple channels exist and channel is omitted", async () => {
    await expect(runPairing(["pairing", "approve", "ABCDEFGH"])).rejects.toThrow("Usage:");
  });
});
