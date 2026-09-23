// Matrix tests cover startup verification plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import { ensureMatrixStartupVerification } from "./startup-verification.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "matrix-startup-verify-"));
}

function createStateFilePath(rootDir: string): string {
  return path.join(rootDir, "startup-verification.json");
}

async function readPersistedStartupState(rootDir: string) {
  const store = createPluginStateKeyedStoreForTests<{
    attemptedAt?: string;
    outcome?: string;
  }>("matrix", {
    namespace: "startup-verification",
    maxEntries: 1_000,
    env: { ...process.env, OPENCLAW_STATE_DIR: rootDir },
  });
  return await store.lookup("default");
}

function createAuth(accountId = "default") {
  return {
    accountId,
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    encryption: true,
  };
}

type VerificationSummaryLike = {
  id: string;
  transactionId?: string;
  isSelfVerification: boolean;
  completed: boolean;
  pending: boolean;
};

function createHarness(params?: {
  verified?: boolean;
  localVerified?: boolean;
  crossSigningVerified?: boolean;
  signedByOwner?: boolean;
  requestVerification?: () => Promise<{ id: string; transactionId?: string }>;
  listVerifications?: () => Promise<VerificationSummaryLike[]>;
}) {
  const requestVerification =
    params?.requestVerification ??
    (async () => ({
      id: "verification-1",
      transactionId: "txn-1",
    }));
  const listVerifications = params?.listVerifications ?? (async () => []);
  const getOwnDeviceVerificationStatus = vi.fn(async () => ({
    encryptionEnabled: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    verified: params?.verified === true,
    localVerified: params?.localVerified ?? params?.verified === true,
    crossSigningVerified: params?.crossSigningVerified ?? params?.verified === true,
    signedByOwner: params?.signedByOwner ?? params?.verified === true,
    recoveryKeyStored: false,
    recoveryKeyCreatedAt: null,
    recoveryKeyId: null,
    backupVersion: null,
    backup: {
      serverVersion: null,
      activeVersion: null,
      trusted: null,
      matchesDecryptionKey: null,
      decryptionKeyCached: null,
      keyLoadAttempted: false,
      keyLoadError: null,
    },
  }));
  return {
    client: {
      getOwnDeviceVerificationStatus,
      crypto: {
        listVerifications: vi.fn(listVerifications),
        requestVerification: vi.fn(requestVerification),
      },
    },
    getOwnDeviceVerificationStatus,
  };
}

function failRoundSevenStartupStateWritesOn(numbers: number[]): void {
  const selected = new Set(numbers);
  let count = 0;
  setMatrixRuntime({
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) => {
        const store = createPluginStateKeyedStoreForTests<unknown>("matrix", options);
        if (options.namespace !== "startup-verification") {
          return store;
        }
        return {
          lookup: store.lookup.bind(store),
          delete: store.delete.bind(store),
          register: async (key: string, value: unknown) => {
            count += 1;
            if (selected.has(count)) {
              throw new Error(`startup state write ${count} failed`);
            }
            return await store.register(key, value);
          },
        };
      },
    },
  } as unknown as PluginRuntime);
}

const ROUND_SEVEN_NOW = Date.parse("2026-03-08T12:00:00.000Z");

async function runRoundSevenStartup(
  harness: ReturnType<typeof createHarness>,
  stateDir: string,
  nowMs = ROUND_SEVEN_NOW,
) {
  return await ensureMatrixStartupVerification({
    client: harness.client as never,
    auth: createAuth(),
    accountConfig: {},
    stateFilePath: createStateFilePath(stateDir),
    nowMs,
  });
}

describe("ensureMatrixStartupVerification", () => {
  beforeEach(() => {
    setMatrixRuntime({
      state: {
        openKeyedStore: (options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests("matrix", options),
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it("skips automatic requests when the device is already verified", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({ verified: true });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
    });

    expect(result.kind).toBe("verified");
    expect(harness.client.crypto.requestVerification).not.toHaveBeenCalled();
  });

  it("still requests startup verification when trust is only local", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      verified: false,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: false,
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
    });

    expect(result.kind).toBe("requested");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
  });

  it("skips automatic requests when a self verification is already pending", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      listVerifications: async () => [
        {
          id: "verification-1",
          transactionId: "txn-1",
          isSelfVerification: true,
          completed: false,
          pending: true,
        },
      ],
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
    });

    expect(result.kind).toBe("pending");
    expect(harness.client.crypto.requestVerification).not.toHaveBeenCalled();
  });

  it("respects the startup verification cooldown", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();
    const initialNowMs = Date.parse("2026-03-08T12:00:00.000Z");
    await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
      nowMs: initialNowMs,
    });
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);

    const second = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
      nowMs: initialNowMs + 60_000,
    });

    expect(second.kind).toBe("cooldown");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
  });

  it("supports disabling startup verification requests", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();
    const stateFilePath = createStateFilePath(tempHome);
    fs.writeFileSync(stateFilePath, JSON.stringify({ attemptedAt: "2026-03-08T12:00:00.000Z" }));

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {
        startupVerification: "off",
      },
      stateFilePath,
    });

    expect(result.kind).toBe("disabled");
    expect(harness.client.crypto.requestVerification).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFilePath)).toBe(false);
  });

  it("persists a successful startup verification request", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness();

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    expect(result.kind).toBe("requested");
    expect(harness.client.crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });

    await expect(readPersistedStartupState(tempHome)).resolves.toMatchObject({
      attemptedAt: "2026-03-08T12:00:00.000Z",
      outcome: "requested",
    });
    expect(fs.existsSync(createStateFilePath(tempHome))).toBe(false);
  });

  it("falls back when startup verification nowMs is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));
    const tempHome = createTempStateDir();
    const stateFilePath = createStateFilePath(tempHome);
    const harness = createHarness();

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath,
      nowMs: 8_640_000_000_000_001,
    });

    expect(result.kind).toBe("requested");
    await expect(readPersistedStartupState(tempHome)).resolves.toMatchObject({
      attemptedAt: "2026-05-30T12:00:00.000Z",
    });
  });

  it("keeps startup verification failures non-fatal", async () => {
    const tempHome = createTempStateDir();
    const harness = createHarness({
      requestVerification: async () => {
        throw new Error("no other verified session");
      },
    });

    const result = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
    });

    expect(result.kind).toBe("request-failed");
    if (result.kind !== "request-failed") {
      throw new Error(`Unexpected startup verification result: ${result.kind}`);
    }
    expect(result.error).toContain("no other verified session");

    const cooledDown = await ensureMatrixStartupVerification({
      client: harness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath: createStateFilePath(tempHome),
      nowMs: Date.now() + 60_000,
    });

    expect(cooledDown.kind).toBe("cooldown");
  });

  it("retries failed startup verification requests sooner than successful ones", async () => {
    const tempHome = createTempStateDir();
    const stateFilePath = createStateFilePath(tempHome);
    const failingHarness = createHarness({
      requestVerification: async () => {
        throw new Error("no other verified session");
      },
    });

    await ensureMatrixStartupVerification({
      client: failingHarness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    const retryingHarness = createHarness();
    const result = await ensureMatrixStartupVerification({
      client: retryingHarness.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath,
      nowMs: Date.parse("2026-03-08T13:30:00.000Z"),
    });

    expect(result.kind).toBe("requested");
    expect(retryingHarness.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
  });

  it("clears the persisted startup state after verification succeeds", async () => {
    const tempHome = createTempStateDir();
    const stateFilePath = createStateFilePath(tempHome);
    const unverified = createHarness();

    await ensureMatrixStartupVerification({
      client: unverified.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath,
      nowMs: Date.parse("2026-03-08T12:00:00.000Z"),
    });

    await expect(readPersistedStartupState(tempHome)).resolves.toBeDefined();

    const verified = createHarness({ verified: true });
    const result = await ensureMatrixStartupVerification({
      client: verified.client as never,
      auth: createAuth(),
      accountConfig: {},
      stateFilePath,
    });

    expect(result.kind).toBe("verified");
    expect(fs.existsSync(stateFilePath)).toBe(false);
    await expect(readPersistedStartupState(tempHome)).resolves.toBeUndefined();
  });
  describe("round-seven verification request persistence", () => {
    it("verification-success-stored", async () => {
      const dir = createTempStateDir();
      const h = createHarness();
      expect((await runRoundSevenStartup(h, dir)).kind).toBe("requested");
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
      await expect(readPersistedStartupState(dir)).resolves.toMatchObject({
        outcome: "requested",
        attemptedAt: "2026-03-08T12:00:00.000Z",
      });
    });

    it("verification-prewrite-fails", async () => {
      failRoundSevenStartupStateWritesOn([1]);
      const dir = createTempStateDir();
      const h = createHarness();
      const result = await runRoundSevenStartup(h, dir);
      expect(result.kind).toBe("request-failed");
      expect(result.error).toContain("startup state write 1 failed");
      expect(h.client.crypto.requestVerification).not.toHaveBeenCalled();
      await expect(readPersistedStartupState(dir)).resolves.toBeUndefined();
    });

    it("verification-postwrite-fails", async () => {
      failRoundSevenStartupStateWritesOn([2]);
      const dir = createTempStateDir();
      const h = createHarness();
      expect((await runRoundSevenStartup(h, dir)).kind).toBe("requested");
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
      await expect(readPersistedStartupState(dir)).resolves.toMatchObject({
        outcome: "attempting",
      });
    });

    it("verification-restart-pending-query-fails", async () => {
      failRoundSevenStartupStateWritesOn([2]);
      let calls = 0;
      const h = createHarness({
        listVerifications: async () => {
          if (++calls === 2) {
            throw new Error("pending query unavailable");
          }
          return [];
        },
      });
      const dir = createTempStateDir();
      expect((await runRoundSevenStartup(h, dir)).kind).toBe("requested");
      const second = await runRoundSevenStartup(h, dir, ROUND_SEVEN_NOW + 60_000);
      expect(second.kind).toBe("request-failed");
      expect(second.error).toContain("startup request was not sent");
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
    });

    it("verification-initial-pending-query-fails", async () => {
      const h = createHarness({
        listVerifications: async () => {
          throw new Error("pending query unavailable");
        },
      });
      expect((await runRoundSevenStartup(h, createTempStateDir())).kind).toBe("request-failed");
      expect(h.client.crypto.requestVerification).not.toHaveBeenCalled();
    });

    it("verification-existing-pending", async () => {
      const h = createHarness({
        listVerifications: async () => [
          {
            id: "existing",
            isSelfVerification: true,
            completed: false,
            pending: true,
          },
        ],
      });
      expect((await runRoundSevenStartup(h, createTempStateDir())).kind).toBe("pending");
      expect(h.client.crypto.requestVerification).not.toHaveBeenCalled();
    });

    it("verification-saved-attempt-cooldown", async () => {
      failRoundSevenStartupStateWritesOn([2]);
      const dir = createTempStateDir();
      const h = createHarness();
      expect((await runRoundSevenStartup(h, dir)).kind).toBe("requested");
      expect((await runRoundSevenStartup(h, dir, ROUND_SEVEN_NOW + 60_000)).kind).toBe("cooldown");
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
    });

    it("verification-cooldown-expires", async () => {
      const dir = createTempStateDir();
      const h = createHarness();
      expect((await runRoundSevenStartup(h, dir)).kind).toBe("requested");
      expect((await runRoundSevenStartup(h, dir, ROUND_SEVEN_NOW + 25 * 60 * 60 * 1000)).kind).toBe(
        "requested",
      );
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(2);
    });

    it("verification-remote-request-fails", async () => {
      const dir = createTempStateDir();
      const h = createHarness({
        requestVerification: async () => {
          throw new Error("remote request rejected");
        },
      });
      const result = await runRoundSevenStartup(h, dir);
      expect(result.kind).toBe("request-failed");
      expect(result.error).toContain("remote request rejected");
      await expect(readPersistedStartupState(dir)).resolves.toMatchObject({ outcome: "failed" });
      expect((await runRoundSevenStartup(h, dir, ROUND_SEVEN_NOW + 60_000)).kind).toBe("cooldown");
      expect(h.client.crypto.requestVerification).toHaveBeenCalledTimes(1);
    });

    it("verification-verified-clears-attempt", async () => {
      failRoundSevenStartupStateWritesOn([2]);
      const dir = createTempStateDir();
      expect((await runRoundSevenStartup(createHarness(), dir)).kind).toBe("requested");
      await expect(readPersistedStartupState(dir)).resolves.toMatchObject({
        outcome: "attempting",
      });
      const verified = createHarness({ verified: true });
      expect((await runRoundSevenStartup(verified, dir, ROUND_SEVEN_NOW + 60_000)).kind).toBe(
        "verified",
      );
      expect(verified.client.crypto.requestVerification).not.toHaveBeenCalled();
      await expect(readPersistedStartupState(dir)).resolves.toBeUndefined();
    });
  });
});
