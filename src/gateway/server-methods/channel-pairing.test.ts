import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOperatorClient } from "../node-invoke-plugin-policy.test-helpers.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { captureGatewayRequestOperatorGuard } from "./session-mutation-guards.js";

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  bootstrapOwner: vi.fn(),
  dismiss: vi.fn(),
  hasOwners: vi.fn(),
  listPlugins: vi.fn(),
  listRequests: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listPlugins,
}));
vi.mock("../../channels/plugins/pairing.js", () => ({
  notifyPairingApproved: mocks.notify,
}));
vi.mock("../../commands/doctor-command-owner.js", () => ({
  hasConfiguredCommandOwners: mocks.hasOwners,
}));
vi.mock("../../pairing/command-owner.js", () => ({
  bootstrapCommandOwnerFromPairing: mocks.bootstrapOwner,
}));
vi.mock("../../pairing/pairing-store.js", () => ({
  approveChannelPairingRequest: mocks.approve,
  CHANNEL_PAIRING_PENDING_MAX: 3,
  CHANNEL_PAIRING_PENDING_TTL_MS: 3_600_000,
  dismissChannelPairingRequest: mocks.dismiss,
  listChannelPairingRequests: mocks.listRequests,
  resolveChannelPairingRequestId: vi.fn(() => "opaque-request-id"),
}));

import { channelPairingHandlers } from "./channel-pairing.js";

const notifyApproval = vi.fn(async () => undefined);
const pairingPlugin = {
  id: "whatsapp",
  meta: { label: "WhatsApp" },
  pairing: { idLabel: "Phone number", notifyApproval },
  config: {
    listAccountIds: () => ["personal", "public", "unconfigured"],
    resolveAccount: (_cfg: unknown, accountId: string) => ({
      configured: accountId !== "unconfigured",
      dmPolicy: accountId === "public" ? "open" : "pairing",
      name: accountId === "personal" ? "Personal" : accountId,
    }),
    isConfigured: (account: { configured: boolean }) => account.configured,
    describeAccount: (account: { name: string }) => ({
      accountId: account.name,
      name: account.name,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: { account: { dmPolicy: string } }) => ({
      policy: account.dmPolicy,
      allowFromPath: "channels.whatsapp.allowFrom",
      approveHint: "approve",
    }),
  },
};

function createContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  };
}

async function invoke(
  method: keyof typeof channelPairingHandlers,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const handler = expectDefined(channelPairingHandlers[method], `${method} test invariant`);
  await handler({
    params,
    respond,
    context: createContext(),
  } as unknown as Parameters<typeof handler>[0]);
  return respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPlugins.mockReturnValue([pairingPlugin]);
  mocks.hasOwners.mockReturnValue(false);
  mocks.listRequests.mockResolvedValue([]);
  mocks.bootstrapOwner.mockResolvedValue({ ownerEntry: "whatsapp:+1555", status: "configured" });
});

describe("channel DM pairing gateway handlers", () => {
  it.each([
    { boundary: "account resolution", revoke: true },
    { boundary: "configured lookup", revoke: true },
    { boundary: "account resolution", revoke: false },
    { boundary: "configured lookup", revoke: false },
  ] as const)(
    "L01-F10 rechecks current pairing approver: $boundary revoked=$revoke",
    async ({ boundary, revoke }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            definitions: {
              pairer: { scopes: ["operator.pairing"], sessions: { others: "none" }, agents: [] },
              viewer: { scopes: [], sessions: { others: "none" }, agents: [] },
            },
          },
        },
      };
      const cfgBefore = structuredClone(cfg);
      const profile = {
        profileId: "fixture-pairer",
        aliases: new Set(["fixture-pairer"]),
        role: "pairer",
      };
      const client = createOperatorClient("fixture-pairing-connection");
      client.connect.role = "operator";
      client.connect.scopes = ["operator.pairing"];
      client.preparedSessionProfile = profile;
      client.authenticatedUserProfile = {
        profileId: profile.profileId,
        displayName: "Fixture pairer",
        avatarRevision: "fixture",
        hasAvatar: false,
        updatedAt: 1,
      };
      const lookups: string[] = [];
      mocks.listPlugins.mockReturnValue([
        {
          ...pairingPlugin,
          config: {
            ...pairingPlugin.config,
            resolveAccountAsync: async (config: unknown, accountId: string) => {
              lookups.push(`resolve:${accountId}`);
              if (boundary === "account resolution") {
                entered.resolve();
                await release.promise;
              }
              return pairingPlugin.config.resolveAccount(config, accountId);
            },
            isConfigured: async (account: { configured: boolean }) => {
              lookups.push("configured:personal");
              if (boundary === "configured lookup") {
                entered.resolve();
                await release.promise;
              }
              return account.configured;
            },
          },
        },
      ]);
      const approved = {
        id: "fixture-sender",
        entry: {
          id: "fixture-sender",
          code: "FIXTURE12",
          createdAt: "2026-07-20T10:00:00.000Z",
          lastSeenAt: "2026-07-20T10:00:00.000Z",
          meta: { accountId: "personal", senderId: "fixture-sender" },
        },
      };
      mocks.approve.mockResolvedValue(approved);
      const params = {
        channel: "whatsapp",
        accountId: "personal",
        requestId: "opaque-request-id",
        notify: false,
        bootstrapCommandOwner: false,
      };
      const paramsBefore = structuredClone(params);
      const respond = vi.fn();
      const handler = expectDefined(
        channelPairingHandlers["channels.pairing.approve"],
        "pairing approve handler",
      );
      const options = {
        req: {
          type: "req",
          id: "fixture-pairing-request",
          method: "channels.pairing.approve",
          params,
        },
        params,
        client,
        respond,
        context: {
          ...createContext(),
          getRuntimeConfig: () => cfg,
          getCommittedRuntimeConfig: () => cfg,
        },
      } as unknown as Parameters<typeof handler>[0];
      expect(authorizeCurrentOperatorRoleScopes(client, cfg)).toBeUndefined();
      const capturedGuard = captureGatewayRequestOperatorGuard(options);
      expect(capturedGuard).not.toThrow();
      let operation: Promise<unknown> | undefined;
      try {
        operation = Promise.resolve(handler(options));
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error("Pairing handler completed before the owned account gate");
          }),
        ]);
        const pendingCalls = {
          approve: mocks.approve.mock.calls.length,
          response: respond.mock.calls.length,
        };
        if (revoke) {
          // Only this owned current-role projection changes, never a profile database or socket.
          profile.role = "viewer";
        }
        const currentRoleError = authorizeCurrentOperatorRoleScopes(client, cfg);
        let capturedGuardError: unknown;
        try {
          capturedGuard();
        } catch (error) {
          capturedGuardError = error;
        }
        release.resolve();
        await operation;
        const observed = {
          pendingCalls,
          roleDenied: currentRoleError?.code === "FORBIDDEN",
          guardDenied: capturedGuardError instanceof Error,
          lookups,
          targets: mocks.approve.mock.calls.map(([target]) => ({
            channel: target.channel,
            accountId: target.accountId,
            requestId: target.requestId,
            pairingAdapter: target.pairingAdapter,
          })),
          responses: respond.mock.calls.map(([ok, result, error]) => ({
            ok,
            result,
            errorPresent: error !== undefined,
          })),
          notifyCalls: mocks.notify.mock.calls.length,
          bootstrapCalls: mocks.bootstrapOwner.mock.calls.length,
          params,
          cfg,
          profileRole: profile.role,
          connectionScopes: client.connect.scopes,
        };
        expect(observed).toEqual({
          pendingCalls: { approve: 0, response: 0 },
          roleDenied: revoke,
          guardDenied: revoke,
          lookups: ["resolve:personal", "configured:personal"],
          targets: revoke
            ? []
            : [
                {
                  channel: "whatsapp",
                  accountId: "personal",
                  requestId: "opaque-request-id",
                  pairingAdapter: pairingPlugin.pairing,
                },
              ],
          responses: revoke
            ? [{ ok: false, result: undefined, errorPresent: true }]
            : [
                {
                  ok: true,
                  result: {
                    requestId: "opaque-request-id",
                    senderId: "fixture-sender",
                    notification: "not-requested",
                    commandOwnerBootstrap: "not-requested",
                  },
                  errorPresent: false,
                },
              ],
          notifyCalls: 0,
          bootstrapCalls: 0,
          params: paramsBefore,
          cfg: cfgBefore,
          profileRole: revoke ? "viewer" : "pairer",
          connectionScopes: ["operator.pairing"],
        });
      } finally {
        release.resolve();
        await operation?.catch(() => undefined);
      }
    },
  );

  it.each(["sync", "async"] as const)(
    "lists only pairing-policy accounts with %s hooks without exposing the human code",
    async (hooks) => {
      if (hooks === "async") {
        const refuseSync = () => {
          throw new Error("legacy operational hook used");
        };
        mocks.listPlugins.mockReturnValue([
          {
            ...pairingPlugin,
            config: {
              ...pairingPlugin.config,
              resolveAccount: refuseSync,
              resolveAccountAsync: async (cfg: unknown, accountId: string) =>
                pairingPlugin.config.resolveAccount(cfg, accountId),
            },
          },
        ]);
      }
      mocks.listRequests.mockResolvedValue([
        {
          id: "workspace:personal:user:+15551234567",
          code: "SECRET12",
          createdAt: "2026-07-20T10:00:00.000Z",
          lastSeenAt: "2026-07-20T10:05:00.000Z",
          meta: { accountId: "personal", name: "Alice", senderId: "+15551234567" },
        },
      ]);

      const respond = await invoke("channels.pairing.list", {});

      expect(mocks.listRequests).toHaveBeenCalledTimes(1);
      expect(mocks.listRequests).toHaveBeenCalledWith("whatsapp", process.env, "personal");
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          accounts: [
            {
              channel: "whatsapp",
              channelLabel: "WhatsApp",
              accountId: "personal",
              accountLabel: "Personal",
              notifySupported: true,
            },
          ],
          requests: [
            {
              requestId: "opaque-request-id",
              channel: "whatsapp",
              channelLabel: "WhatsApp",
              accountId: "personal",
              accountLabel: "Personal",
              senderId: "+15551234567",
              senderLabel: "Phone number",
              metadata: { name: "Alice" },
              createdAt: "2026-07-20T10:00:00.000Z",
              lastSeenAt: "2026-07-20T10:05:00.000Z",
              expiresAt: "2026-07-20T11:00:00.000Z",
              notifySupported: true,
            },
          ],
          commandOwnerConfigured: false,
          limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
        },
        undefined,
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain("SECRET12");
    },
  );

  it("approves access even when the optional notification fails", async () => {
    mocks.approve.mockResolvedValue({
      id: "workspace:personal:user:+15551234567",
      entry: {
        id: "workspace:personal:user:+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        meta: { accountId: "personal", senderId: "+15551234567" },
      },
    });
    mocks.notify.mockRejectedValue(new Error("offline"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      notify: true,
      bootstrapCommandOwner: true,
    });

    expect(mocks.approve).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      pairingAdapter: pairingPlugin.pairing,
    });
    expect(mocks.bootstrapOwner).toHaveBeenCalledWith({
      channel: "whatsapp",
      id: "workspace:personal:user:+15551234567",
    });
    expect(mocks.notify).toHaveBeenCalledWith({
      channelId: "whatsapp",
      accountId: "personal",
      id: "workspace:personal:user:+15551234567",
      cfg: expect.any(Object),
      pairingAdapter: pairingPlugin.pairing,
      meta: { accountId: "personal", senderId: "+15551234567" },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "failed",
        commandOwnerBootstrap: "configured",
      },
      undefined,
    );
  });

  it("reports command-owner setup failure without rolling back DM approval", async () => {
    mocks.approve.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });
    mocks.bootstrapOwner.mockRejectedValue(new Error("config write failed"));

    const respond = await invoke("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
      bootstrapCommandOwner: true,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        requestId: "opaque-request-id",
        senderId: "+15551234567",
        notification: "not-requested",
        commandOwnerBootstrap: "unavailable",
      },
      undefined,
    );
  });

  it("dismisses a request without approving the sender", async () => {
    mocks.dismiss.mockResolvedValue({
      id: "+15551234567",
      entry: {
        id: "+15551234567",
        code: "SECRET12",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
      },
    });

    const respond = await invoke("channels.pairing.dismiss", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });

    expect(mocks.dismiss).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "opaque-request-id",
    });
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { requestId: "opaque-request-id", senderId: "+15551234567" },
      undefined,
    );
  });
});
