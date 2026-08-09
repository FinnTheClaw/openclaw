import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  applyCommunicationIdentityConfig,
  createCommunicationIdentityRegistryForTest,
  planCommunicationAdminTransfer,
  planCommunicationIdentityApproval,
  seedCommunicationIdentityRegistryFromConfigOwners,
} from "./communication-identities.js";
import { resolveCommunicationIdentityPromptCacheKey } from "./communication-identity-prompt-cache.js";

const STATE_DIR = "/tmp/openclaw-identity-test";
const ADMIN_PHONE = "+15125550101";
const GUEST_PHONE = "+15125550102";

function approve(params: {
  registry?: ReturnType<typeof createCommunicationIdentityRegistryForTest>;
  channel: string;
  accountId?: string;
  peerId: string;
  phone?: string;
}) {
  return planCommunicationIdentityApproval({
    registry: params.registry,
    stateDir: STATE_DIR,
    channel: params.channel,
    accountId: params.accountId,
    peerId: params.peerId,
    identityPhone: params.phone,
    now: new Date("2026-01-02T00:00:00.000Z"),
  });
}

function configFixture(): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "finn",
          default: true,
          workspace: "/trusted/admin-workspace",
          tools: {
            profile: "full",
            elevated: { enabled: true, allowFrom: { signal: ["*"] } },
            fs: { workspaceOnly: false },
          },
        },
      ],
    },
    tools: {
      profile: "full",
      elevated: { enabled: true, allowFrom: { signal: ["*"] } },
      fs: { workspaceOnly: false },
    },
    commands: { ownerAllowFrom: ["signal:*"] },
    bindings: [
      {
        type: "route",
        agentId: "finn",
        comment: "legacy broad route",
        match: { channel: "signal", accountId: "*" },
      },
    ],
  } as OpenClawConfig;
}

describe("communication identity isolation", () => {
  it("keeps 250 fake people and 500 cross-channel endpoints fully disjoint", () => {
    const personCount = 250;
    let registry = createCommunicationIdentityRegistryForTest();
    const identities: Array<{
      phone: string;
      signalPeer: string;
      whatsappPeer: string;
      identityId: string;
      agentId: string;
      workspace: string;
    }> = [];

    for (let index = 0; index < personCount; index += 1) {
      const phone = `+${15551000000 + index}`;
      const signalPeer = `signal-test-${String(index).padStart(4, "0")}`;
      const whatsappPeer = `${phone.slice(1)}@s.whatsapp.net`;
      const signal = approve({
        registry,
        channel: "signal",
        accountId: "primary",
        peerId: signalPeer,
        phone,
      });
      const whatsapp = approve({
        registry: signal.registry,
        channel: "whatsapp",
        accountId: "family",
        peerId: whatsappPeer,
        phone,
      });
      expect(whatsapp.identity.id).toBe(signal.identity.id);
      expect(whatsapp.identity.workspace).toBe(signal.identity.workspace);
      expect(whatsapp.identity.endpoints).toHaveLength(2);
      registry = whatsapp.registry;
      identities.push({
        phone,
        signalPeer,
        whatsappPeer,
        identityId: whatsapp.identity.id,
        agentId: whatsapp.identity.memberAgentId,
        workspace: whatsapp.identity.workspace,
      });
    }

    expect(Object.keys(registry.identities)).toHaveLength(personCount);
    expect(new Set(identities.map((identity) => identity.identityId)).size).toBe(personCount);
    expect(new Set(identities.map((identity) => identity.agentId)).size).toBe(personCount);
    expect(new Set(identities.map((identity) => identity.workspace)).size).toBe(personCount);
    expect(identities.every((identity) => !identity.workspace.includes(identity.phone))).toBe(true);

    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry,
      stateDir: STATE_DIR,
    });
    const validation = validateConfigObjectRaw(projected);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
    expect(projected.commands?.ownerAllowFrom).toEqual([
      "signal:signal-test-0000",
      "whatsapp:15551000000@s.whatsapp.net",
    ]);

    const cacheKeys = new Set<string>();
    for (const index of [0, 1, 17, 63, 127, 249]) {
      const identity = identities[index];
      expect(identity).toBeDefined();
      if (!identity) {
        continue;
      }
      const signalRoute = resolveAgentRoute({
        cfg: projected,
        channel: "signal",
        accountId: "primary",
        peer: { kind: "direct", id: identity.signalPeer },
      });
      const whatsappRoute = resolveAgentRoute({
        cfg: projected,
        channel: "whatsapp",
        accountId: "family",
        peer: { kind: "direct", id: identity.whatsappPeer },
      });
      const expectedAgent = index === 0 ? "finn" : identity.agentId;
      expect(signalRoute.agentId).toBe(expectedAgent);
      expect(whatsappRoute.agentId).toBe(expectedAgent);
      expect(signalRoute.sessionKey).not.toBe(whatsappRoute.sessionKey);
      cacheKeys.add(
        resolveCommunicationIdentityPromptCacheKey({
          agentId: expectedAgent,
          sessionKey: signalRoute.sessionKey,
          provider: "remote-llm",
          model: "moira/brain",
        }),
      );
      cacheKeys.add(
        resolveCommunicationIdentityPromptCacheKey({
          agentId: expectedAgent,
          sessionKey: whatsappRoute.sessionKey,
          provider: "remote-llm",
          model: "moira/brain",
        }),
      );
      if (index > 0) {
        const agent = projected.agents?.list?.find((candidate) => candidate.id === expectedAgent);
        expect(agent?.sandbox).toMatchObject({ mode: "all", backend: "docker" });
        expect(agent?.tools?.fs?.workspaceOnly).toBe(true);
        expect(agent?.tools?.elevated?.enabled).toBe(false);
      }
    }
    expect(cacheKeys.size).toBe(12);

    const unknown = resolveAgentRoute({
      cfg: projected,
      channel: "whatsapp",
      accountId: "family",
      peer: { kind: "direct", id: "15559999999@s.whatsapp.net" },
    });
    expect(unknown.agentId).toBe("communication-quarantine");
  });

  it("converges the same phone across channels and reconnects idempotently", () => {
    const signal = approve({
      channel: "signal",
      accountId: "primary",
      peerId: ADMIN_PHONE,
    });
    expect(signal.bootstrappedAdmin).toBe(true);

    const whatsapp = approve({
      registry: signal.registry,
      channel: "whatsapp",
      accountId: "family",
      peerId: "15551239876@s.whatsapp.net",
      phone: ADMIN_PHONE,
    });
    expect(whatsapp.identity.id).toBe(signal.identity.id);
    expect(whatsapp.identity.memberAgentId).toBe(signal.identity.memberAgentId);
    expect(whatsapp.identity.workspace).toBe(signal.identity.workspace);
    expect(whatsapp.identity.endpoints).toHaveLength(2);

    const repeated = approve({
      registry: whatsapp.registry,
      channel: "signal",
      accountId: "primary",
      peerId: ADMIN_PHONE,
    });
    expect(repeated.identity.id).toBe(signal.identity.id);
    expect(repeated.endpointAdded).toBe(false);
    expect(repeated.identity.endpoints).toHaveLength(2);
  });

  it("keeps distinct phone identities, paths, and identity links disjoint", () => {
    const admin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const guest = approve({
      registry: admin.registry,
      channel: "signal",
      peerId: GUEST_PHONE,
    });
    expect(guest.identity.id).not.toBe(admin.identity.id);
    expect(guest.identity.memberAgentId).not.toBe(admin.identity.memberAgentId);
    expect(guest.identity.workspace).not.toBe(admin.identity.workspace);
    expect(guest.identity.workspace).not.toContain(GUEST_PHONE);
    expect(guest.isAdmin).toBe(false);

    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry: guest.registry,
      stateDir: STATE_DIR,
    });
    const links = Object.entries(projected.session?.identityLinks ?? {});
    expect(links).toHaveLength(2);
    expect(links[0]?.[1]).not.toEqual(links[1]?.[1]);
    expect(projected.session?.dmScope).toBe("per-account-channel-peer");
  });

  it("keeps local TUI/admin unrestricted and nonadmins container-confined", () => {
    const admin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const guest = approve({
      registry: admin.registry,
      channel: "whatsapp",
      peerId: GUEST_PHONE,
    });
    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry: guest.registry,
      stateDir: STATE_DIR,
    });
    const trusted = projected.agents?.list?.find((agent) => agent.id === "finn");
    const isolated = projected.agents?.list?.find(
      (agent) => agent.id === guest.identity.memberAgentId,
    );
    const quarantine = projected.agents?.list?.find(
      (agent) => agent.id === "communication-quarantine",
    );

    expect(trusted?.sandbox?.mode).toBe("off");
    expect(trusted?.tools?.profile).toBe("full");
    expect(trusted?.tools?.fs?.workspaceOnly).toBe(false);
    expect(trusted?.tools?.exec?.host).toBe("auto");
    expect(trusted?.tools?.elevated?.allowFrom).toEqual({ signal: [ADMIN_PHONE] });

    expect(isolated?.workspace).toBe(guest.identity.workspace);
    expect(isolated?.agentDir).toBe(guest.identity.agentDir);
    expect(isolated?.sandbox).toMatchObject({
      mode: "all",
      backend: "docker",
      scope: "agent",
      workspaceAccess: "rw",
      docker: { network: "none", readOnlyRoot: true, capDrop: ["ALL"] },
    });
    expect(isolated?.tools?.fs?.workspaceOnly).toBe(true);
    expect(isolated?.tools?.exec?.host).toBe("sandbox");
    expect(isolated?.tools?.elevated?.enabled).toBe(false);
    expect(isolated?.tools?.deny).toEqual(
      expect.arrayContaining(["gateway", "message", "sessions_send", "subagents", "image"]),
    );

    expect(quarantine?.sandbox).toMatchObject({ mode: "all", workspaceAccess: "none" });
    expect(quarantine?.tools?.allow).toEqual(["session_status"]);
    expect(projected.tools?.elevated?.allowFrom).toEqual({ signal: [ADMIN_PHONE] });
    expect(projected.commands?.ownerAllowFrom).toEqual([`signal:${ADMIN_PHONE}`]);
  });

  it("projects a configuration accepted by the production schema", () => {
    const admin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const guest = approve({
      registry: admin.registry,
      channel: "whatsapp",
      accountId: "family",
      peerId: "15551255502@s.whatsapp.net",
      phone: GUEST_PHONE,
    });
    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry: guest.registry,
      stateDir: STATE_DIR,
    });
    const validation = validateConfigObjectRaw(projected);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
  });

  it("routes exact identities first, quarantines unknown peers next, and only then preserves broad routes", () => {
    const admin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const guest = approve({
      registry: admin.registry,
      channel: "signal",
      accountId: "secondary",
      peerId: GUEST_PHONE,
    });
    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry: guest.registry,
      stateDir: STATE_DIR,
    });
    const bindings = projected.bindings ?? [];
    const exactAdmin = bindings.findIndex(
      (binding) => binding.type === "route" && binding.comment?.includes(admin.identity.id),
    );
    const exactGuest = bindings.findIndex(
      (binding) => binding.type === "route" && binding.comment?.includes(guest.identity.id),
    );
    const quarantineDirect = bindings.findIndex(
      (binding) =>
        binding.type === "route" &&
        binding.agentId === "communication-quarantine" &&
        binding.match.peer?.kind === "direct",
    );
    const legacy = bindings.findIndex((binding) => binding.comment === "legacy broad route");
    expect(exactAdmin).toBeGreaterThanOrEqual(0);
    expect(exactGuest).toBeGreaterThanOrEqual(0);
    expect(quarantineDirect).toBeGreaterThan(exactGuest);
    expect(legacy).toBeGreaterThan(quarantineDirect);
    expect(bindings[exactAdmin]).toMatchObject({ agentId: "finn" });
    expect(bindings[exactGuest]).toMatchObject({ agentId: guest.identity.memberAgentId });

    const adminRoute = resolveAgentRoute({
      cfg: projected,
      channel: "signal",
      accountId: "default",
      peer: { kind: "direct", id: ADMIN_PHONE },
    });
    const guestRoute = resolveAgentRoute({
      cfg: projected,
      channel: "signal",
      accountId: "secondary",
      peer: { kind: "direct", id: GUEST_PHONE },
    });
    const unknownRoute = resolveAgentRoute({
      cfg: projected,
      channel: "signal",
      accountId: "default",
      peer: { kind: "direct", id: "+15125550999" },
    });
    const unknownGroup = resolveAgentRoute({
      cfg: projected,
      channel: "signal",
      accountId: "default",
      peer: { kind: "group", id: "unapproved-group" },
    });
    expect(adminRoute.agentId).toBe("finn");
    expect(guestRoute.agentId).toBe(guest.identity.memberAgentId);
    expect(unknownRoute.agentId).toBe("communication-quarantine");
    expect(unknownGroup.agentId).toBe("communication-quarantine");
    expect(
      new Set([adminRoute.sessionKey, guestRoute.sessionKey, unknownRoute.sessionKey]).size,
    ).toBe(3);
  });

  it("quarantines unknown peers on configured channels before their first approval", () => {
    const admin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const projected = applyCommunicationIdentityConfig({
      config: {
        ...configFixture(),
        channels: { telegram: {} },
      } as OpenClawConfig,
      registry: admin.registry,
      stateDir: STATE_DIR,
    });
    const route = resolveAgentRoute({
      cfg: projected,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "direct", id: "unapproved-telegram-user" },
    });
    expect(route.agentId).toBe("communication-quarantine");
  });

  it("fails closed when one endpoint is claimed by two canonical people", () => {
    const first = approve({
      channel: "signal",
      peerId: "signal-uuid-1",
      phone: ADMIN_PHONE,
    });
    expect(() =>
      approve({
        registry: first.registry,
        channel: "signal",
        peerId: "signal-uuid-1",
        phone: GUEST_PHONE,
      }),
    ).toThrow("already bound to another isolated identity");
  });

  it("refuses opaque phone-channel endpoints without a canonical phone", () => {
    expect(() => approve({ channel: "signal", peerId: "signal-uuid-without-phone" })).toThrow(
      "requires a canonical E.164 phone identity",
    );
    expect(() =>
      approve({ channel: "whatsapp", peerId: "opaque-device-jid-without-phone" }),
    ).toThrow("requires a canonical E.164 phone identity");
  });

  it("transfers admin authority without discarding either private workspace", () => {
    const oldAdmin = approve({ channel: "signal", peerId: ADMIN_PHONE });
    const oldAdminWhatsapp = approve({
      registry: oldAdmin.registry,
      channel: "whatsapp",
      peerId: ADMIN_PHONE,
    });
    const transfer = planCommunicationAdminTransfer({
      registry: oldAdminWhatsapp.registry,
      stateDir: STATE_DIR,
      phone: GUEST_PHONE,
    });
    const newAdmin = approve({
      registry: transfer.registry,
      channel: "signal",
      peerId: GUEST_PHONE,
    });
    const projected = applyCommunicationIdentityConfig({
      config: configFixture(),
      registry: newAdmin.registry,
      stateDir: STATE_DIR,
    });
    const oldRoutes = projected.bindings?.filter(
      (binding) => binding.type === "route" && binding.comment?.includes(oldAdmin.identity.id),
    );
    const newRoutes = projected.bindings?.filter(
      (binding) => binding.type === "route" && binding.comment?.includes(newAdmin.identity.id),
    );
    expect(oldRoutes).toHaveLength(2);
    expect(oldRoutes?.every((binding) => binding.agentId === oldAdmin.identity.memberAgentId)).toBe(
      true,
    );
    expect(newRoutes).toHaveLength(1);
    expect(newRoutes?.[0]).toMatchObject({ agentId: "finn" });
    expect(
      projected.agents?.list?.some((agent) => agent.id === oldAdmin.identity.memberAgentId),
    ).toBe(true);
    expect(projected.commands?.ownerAllowFrom).toEqual([`signal:${GUEST_PHONE}`]);
  });

  it("does not promote legacy non-phone owners while migrating a valid phone owner", () => {
    const empty = createCommunicationIdentityRegistryForTest();
    const migrated = seedCommunicationIdentityRegistryFromConfigOwners({
      registry: empty,
      stateDir: STATE_DIR,
      config: {
        commands: { ownerAllowFrom: ["discord:untrusted-handle", `signal:${ADMIN_PHONE}`] },
      } as OpenClawConfig,
    });
    expect(Object.values(migrated.identities)).toHaveLength(1);
    expect(migrated.identities[migrated.adminIdentityId ?? ""]?.phone).toBe(ADMIN_PHONE);
  });

  it("never treats projected owners as migration input after the registry is initialized", () => {
    const initialized = approve({
      channel: "signal",
      accountId: "main",
      peerId: ADMIN_PHONE,
    }).registry;
    const migrated = seedCommunicationIdentityRegistryFromConfigOwners({
      registry: initialized,
      stateDir: STATE_DIR,
      config: {
        commands: {
          ownerAllowFrom: [`signal:${ADMIN_PHONE}`, `whatsapp:${ADMIN_PHONE}`],
        },
      } as OpenClawConfig,
    });
    const admin = migrated.identities[migrated.adminIdentityId ?? ""];
    expect(admin?.endpoints).toHaveLength(1);
    expect(admin?.endpoints[0]).toMatchObject({ channel: "signal", accountId: "main" });
  });

  it("does not let a non-phone first pairing silently become admin", () => {
    const discord = approve({ channel: "discord", peerId: "user-123" });
    expect(discord.bootstrappedAdmin).toBe(false);
    expect(discord.registry.adminIdentityId).toBeNull();
  });
});
