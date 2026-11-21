import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const runtimeApplication = { claimed: true };
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewayRestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));
const restartSentinelMocks = vi.hoisted(() => ({
  writeRestartSentinel: vi.fn(async (_payload: RestartSentinelPayload) => undefined),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: async (params: { sourceConfig: OpenClawConfig; writeOptions?: object }) => {
    await writeConfigFileMock(params.sourceConfig, params.writeOptions);
    if (params.writeOptions && runtimeApplication.claimed) {
      getRuntimeConfigWriteApplication(params.writeOptions)?.claim()?.settle("applied");
    }
    return {
      path: "/tmp/openclaw.json",
      previousHash: "base-hash",
      snapshot: createConfigWriteSnapshot(params.sourceConfig),
      nextConfig: params.sourceConfig,
      persistedHash: "next-hash",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    };
  },
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
}));

vi.mock("../../config/validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/validation.js")>()),
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
}));

vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayConfigRedactionHints: () => undefined,
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeSnapshotState: () => null,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewayRestart: scheduleGatewayRestartMock,
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: restartSentinelMocks.writeRestartSentinel,
}));

const { configHandlers } = await import("./config.js");

function tokenAuthConfig(token: string): OpenClawConfig {
  return { gateway: { auth: { mode: "token", token } } };
}

function mockPreviousConfig(config: OpenClawConfig): void {
  readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(config));
}

function prepareWrite(
  method: string,
  raw: unknown,
  params: Record<string, unknown> = {},
  contextOverrides?: NonNullable<
    Parameters<typeof createConfigHandlerHarness>[0]
  >["contextOverrides"],
) {
  return createConfigHandlerHarness({
    method,
    params: {
      baseHash: "base-hash",
      raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      ...params,
    },
    contextOverrides,
  });
}

async function runWrite(...args: Parameters<typeof prepareWrite>) {
  const harness = prepareWrite(...args);
  await expectDefined(configHandlers[args[0]], args[0])(harness.options);
  await flushConfigHandlerMicrotasks();
  return harness;
}

const ttsConfig: OpenClawConfig = {
  tts: {
    providers: {
      elevenlabs: {
        apiKey: { source: "env", provider: "default", id: "ELEVENLABS_API_KEY" },
      },
    },
  },
};
function mockDegradedTts(reason: string) {
  mockPreviousConfig({});
  prepareSecretsRuntimeSnapshotMock.mockResolvedValueOnce({
    config: ttsConfig,
    degradedOwners: [
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        degradationState: "cold",
        paths: ["tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:ELEVENLABS_API_KEY"],
        reason,
      },
    ],
  });
}

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  runtimeApplication.claimed = true;
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockImplementation(
    async ({ config }: { config: OpenClawConfig }) => ({ config }),
  );
});

describe("config shared auth disconnects", () => {
  it.each([
    { method: "config.patch", claimed: true },
    { method: "config.apply", claimed: true },
    { method: "config.patch", claimed: false },
    { method: "config.apply", claimed: false },
    { method: "config.set", claimed: false },
  ] as const)(
    "keeps $method auth reconciliation with its owner (claimed=$claimed)",
    async ({ method, claimed }) => {
      runtimeApplication.claimed = claimed;
      const nextConfig = tokenAuthConfig("new-token");
      mockPreviousConfig(tokenAuthConfig("old-token"));
      const enforceGeneration = vi.fn();
      const { respond, disconnectClientsUsingSharedGatewayAuth } = await runWrite(
        method,
        nextConfig,
        {},
        { enforceSharedGatewayAuthGenerationForConfigWrite: enforceGeneration },
      );
      expect(respond).toHaveBeenCalledWith(
        claimed || method === "config.set",
        claimed || method === "config.set" ? expect.objectContaining({ ok: true }) : undefined,
        claimed || method === "config.set"
          ? undefined
          : expect.objectContaining({ message: expect.stringContaining("unclaimed") }),
      );
      expect(enforceGeneration).toHaveBeenCalledTimes(claimed ? 0 : 1);
      expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(
        !claimed && method !== "config.set" ? 1 : 0,
      );
      if (!claimed) {
        expect(enforceGeneration).toHaveBeenCalledWith(nextConfig, tokenAuthConfig("old-token"));
        expect(respond).toHaveBeenCalledBefore(enforceGeneration);
      }
    },
  );

  it("withholds config acknowledgement until its restart sentinel write settles", async () => {
    mockPreviousConfig(tokenAuthConfig("old-token"));
    const started = createDeferred();
    const release = createDeferred();
    restartSentinelMocks.writeRestartSentinel.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
    });
    const { options, respond } = prepareWrite("config.apply", tokenAuthConfig("new-token"), {
      restartDelayMs: 1000,
    });
    const handler = expectDefined(configHandlers["config.apply"], "config.apply handler");
    const operation = Promise.resolve(handler(options));
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        operation,
        "Config did not reach sentinel persistence",
      );
      expect(respond).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await operation;
    }
    expectRpcResult(respond, expect.objectContaining({ ok: true, hash: "next-hash" }));
  });

  it("accepts an unresolved isolatable TTS SecretRef and reports the cold owner", async () => {
    mockDegradedTts("secret reference was not found");
    const { respond } = await runWrite("config.set", ttsConfig);
    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledWith({
      config: ttsConfig,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    expect(writeConfigFileMock).toHaveBeenCalled();
    expect(respond.mock.calls[0]).toMatchObject([
      true,
      {
        degradedSecretOwners: [
          {
            ownerKind: "capability",
            ownerId: "tts",
            state: "cold",
            reason: "secret reference was not found",
          },
        ],
      },
      undefined,
    ]);
  });

  it("rejects non-retryable SecretRef degradation before config writes", async () => {
    const reason = "secret provider policy denied resolution";
    mockDegradedTts(reason);
    const { respond } = await runWrite("config.set", ttsConfig);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expectRpcError(respond, { message: expect.stringContaining(reason) });
  });

  it.each(["config.patch", "config.apply"] as const)(
    "%s hot-applies same-mode credentials and retains restart ownership for mode switches",
    async (method) => {
      for (const mode of ["token", "password"] as const) {
        for (const changesMode of [false, true]) {
          const previous = { gateway: { auth: { mode, [mode]: "old-credential" } } };
          const nextMode = changesMode ? (mode === "token" ? "password" : "token") : mode;
          const next = { gateway: { auth: { mode: nextMode, [nextMode]: "new-credential" } } };
          mockPreviousConfig(previous);
          const { respond, disconnectClientsUsingSharedGatewayAuth } = await runWrite(method, next);
          expect(respond.mock.calls[0]).toMatchObject([
            true,
            {
              restart: undefined,
              sentinel: { payload: { stats: { requiresRestart: changesMode } } },
            },
            undefined,
          ]);
          expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(
            changesMode ? 1 : 0,
          );
        }
      }
    },
  );

  it("leaves unclaimed trusted-proxy grant writes to per-client policy reconciliation", async () => {
    runtimeApplication.claimed = false;
    const proxyPolicy = (user: string) => ({
      userHeader: "x-forwarded-user",
      allowUsers: [user],
    });
    mockPreviousConfig({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: proxyPolicy("alice@example.com"),
        },
        trustedProxies: ["127.0.0.1"],
      },
    });

    const { disconnectClientsUsingSharedGatewayAuth } = await runWrite(
      "config.patch",
      { gateway: { auth: { trustedProxy: proxyPolicy("bob@example.com") } } },
      { restartDelayMs: 1_000, replacePaths: ["gateway.auth.trustedProxy.allowUsers"] },
    );

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("defers restart-required changes to the watcher after legacy hot mode normalizes", async () => {
    mockPreviousConfig({ gateway: { reload: { mode: "hot" } } });

    await runWrite("config.patch", { gateway: { port: 19001 } }, { restartDelayMs: 1_000 });

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(restartSentinelMocks.writeRestartSentinel).not.toHaveBeenCalled();
  });
});

const authorityTempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([false, true])(
  "config.set retained publication authority: invalidate=%s",
  async (invalidate) => {
    const previousConfig: OpenClawConfig = { gateway: { port: 19000 } };
    const submittedConfig: OpenClawConfig = { gateway: { port: 19001 } };
    const originalBytes = Buffer.from(JSON.stringify(previousConfig) + "\n");
    const requestedBytes = Buffer.from(JSON.stringify(submittedConfig) + "\n");
    const filePath = path.join(
      authorityTempDirs.make("config-authority-publication-"),
      "owned-publication-mirror.json",
    );
    fs.writeFileSync(filePath, originalBytes);
    const secretEntered = createDeferred();
    const releaseSecrets = createDeferred();
    const oldPrepare = prepareSecretsRuntimeSnapshotMock.getMockImplementation();
    const oldWrite = writeConfigFileMock.getMockImplementation();
    const oldRead = readConfigFileSnapshotForWriteMock.getMockImplementation();
    const sourceGuard = vi.fn();
    const revokedError = new Error("fixture retained config authority invalidated");
    let authorityCurrent = true;
    let publications = 0;
    let publicationBoundaryCalls = 0;
    let save: Promise<{ error: unknown }> | undefined;
    const harness = createConfigHandlerHarness({
      method: "config.set",
      params: { raw: JSON.stringify(submittedConfig), baseHash: "base-hash" },
      overrides: {
        sessionMutationCommitGuard: () => {
          if (!authorityCurrent) {
            throw revokedError;
          }
        },
      },
      contextOverrides: { getRuntimeConfig: () => previousConfig },
    });
    const bound = bindGatewayRequestHandlerMutationAuthority(
      harness.options,
      harness.options,
      undefined,
    );
    try {
      readGatewayRequestMutationAuthority(bound).assertCurrent();
      readConfigFileSnapshotForWriteMock.mockImplementation(async () => ({
        ...createConfigWriteSnapshot(previousConfig),
        writeOptions: { assertCurrent: sourceGuard },
      }));
      prepareSecretsRuntimeSnapshotMock.mockImplementation(
        async ({ config }: { config: OpenClawConfig }) => {
          secretEntered.resolve();
          await releaseSecrets.promise;
          return { config };
        },
      );
      writeConfigFileMock.mockImplementation(
        async (config: OpenClawConfig, options?: { assertCurrent?: () => void }) => {
          publicationBoundaryCalls++;
          options?.assertCurrent?.();
          fs.writeFileSync(filePath, JSON.stringify(config) + "\n");
          publications++;
        },
      );
      save = Promise.resolve(
        expectDefined(configHandlers["config.set"], "config.set handler")(bound),
      ).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        secretEntered.promise,
        save.then((result) => {
          throw result.error ?? new Error("config.set completed before secret preparation");
        }),
      ]);
      authorityCurrent = !invalidate;
      releaseSecrets.resolve();
      const outcome = await save;
      await flushConfigHandlerMicrotasks();
      const observed = {
        bytes: fs.readFileSync(filePath),
        publications,
        responses: harness.respond.mock.calls.slice(),
        error: outcome.error,
        sourceGuardCalls: sourceGuard.mock.calls.length,
        publicationBoundaryCalls,
        restarts: scheduleGatewayRestartMock.mock.calls.length,
        disconnects: harness.disconnectClientsUsingSharedGatewayAuth.mock.calls.length,
        previousConfig: structuredClone(previousConfig),
        submittedConfig: structuredClone(submittedConfig),
      };
      expect(observed.bytes).toEqual(invalidate ? originalBytes : requestedBytes);
      expect(observed.publications).toBe(invalidate ? 0 : 1);
      expect(observed.error).toBe(invalidate ? revokedError : undefined);
      expect(observed.responses).toEqual(
        invalidate
          ? []
          : [
              [
                true,
                {
                  ok: true,
                  path: "/tmp/openclaw.json",
                  hash: "next-hash",
                  config: submittedConfig,
                },
                undefined,
              ],
            ],
      );
      if (!invalidate) {
        expect(observed.sourceGuardCalls).toBe(1);
        expect(observed.publicationBoundaryCalls).toBe(1);
      }
      expect(observed.restarts).toBe(0);
      expect(observed.disconnects).toBe(0);
      expect(observed.previousConfig).toEqual({ gateway: { port: 19000 } });
      expect(observed.submittedConfig).toEqual({ gateway: { port: 19001 } });
    } finally {
      releaseSecrets.resolve();
      await save;
      prepareSecretsRuntimeSnapshotMock.mockImplementation(
        oldPrepare ?? (async ({ config }: { config: OpenClawConfig }) => ({ config })),
      );
      writeConfigFileMock.mockImplementation(oldWrite ?? (() => undefined));
      readConfigFileSnapshotForWriteMock.mockImplementation(oldRead ?? (() => undefined));
    }
  },
);
