import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  failProjection: false,
}));

vi.mock("../agents/workspace.js", () => ({
  ensureAgentWorkspace: async (params: { dir: string }) => {
    await fs.promises.mkdir(params.dir, { recursive: true, mode: 0o700 });
    return { dir: params.dir };
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => structuredClone(mocks.config),
  mutateConfigFileWithRetry: async (params: {
    mutate: (draft: OpenClawConfig) => void | Promise<void>;
  }) => {
    if (mocks.failProjection) {
      throw new Error("injected config projection failure");
    }
    const draft = structuredClone(mocks.config);
    await params.mutate(draft);
    mocks.config = draft;
    return { config: draft };
  },
}));

import {
  ensureCommunicationIdentityForPairing,
  listCommunicationIdentities,
  reconcileCommunicationIdentityConfig,
  resolveCommunicationIdentityRegistryPath,
} from "./communication-identities.js";

describe("communication identity runtime durability", () => {
  let tempRoot = "";
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-runtime-"));
    stateDir = path.join(tempRoot, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    mocks.failProjection = false;
    mocks.config = {
      agents: { list: [{ id: "finn", default: true, workspace: "/trusted" }] },
      commands: { ownerAllowFrom: [] },
    } as OpenClawConfig;
  });

  afterEach(async () => {
    mocks.failProjection = false;
    if (tempRoot) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent pairings without duplicate endpoints or identity drift", async () => {
    const admin = await ensureCommunicationIdentityForPairing({
      channel: "signal",
      peerId: "+15125550101",
      env,
    });
    expect(admin.bootstrappedAdmin).toBe(true);

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        ensureCommunicationIdentityForPairing({
          channel: index % 2 === 0 ? "signal" : "whatsapp",
          accountId: index % 3 === 0 ? "secondary" : "default",
          peerId: `+1512555${String(index + 200).padStart(4, "0")}`,
          env,
        }),
      ),
    );
    const listed = await listCommunicationIdentities(env);
    expect(listed.identities).toHaveLength(25);
    expect(new Set(listed.identities.map((identity) => identity.id)).size).toBe(25);
    expect(new Set(listed.identities.map((identity) => identity.workspace)).size).toBe(25);
    expect(listed.identities.flatMap((identity) => identity.endpoints)).toHaveLength(25);
    expect(mocks.config.commands?.ownerAllowFrom).toEqual(["signal:+15125550101"]);
    expect(
      mocks.config.agents?.list?.filter((agent) => agent.id.startsWith("person-")).length,
    ).toBe(25);
  });

  it("recovers a durable pending projection after an injected config-write failure", async () => {
    mocks.failProjection = true;
    await expect(
      ensureCommunicationIdentityForPairing({
        channel: "signal",
        peerId: "+15125550101",
        env,
      }),
    ).rejects.toThrow("injected config projection failure");

    const registryPath = resolveCommunicationIdentityRegistryPath(env);
    await expect(fs.promises.access(`${registryPath}.pending`)).resolves.toBeUndefined();
    expect(JSON.parse(await fs.promises.readFile(registryPath, "utf8")).identities).toEqual({});

    mocks.failProjection = false;
    const recovered = await listCommunicationIdentities(env);
    expect(recovered.identities).toHaveLength(1);
    expect(recovered.adminIdentityId).toBe(recovered.identities[0]?.id);
    await expect(fs.promises.access(`${registryPath}.pending`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mocks.config.commands?.ownerAllowFrom).toEqual(["signal:+15125550101"]);
  });

  it("rebinds repaired channels to one durable person and restores policy after restart", async () => {
    const signal = await ensureCommunicationIdentityForPairing({
      channel: "signal",
      peerId: "signal-admin-uuid",
      identityPhone: "+15125550101",
      env,
    });
    const whatsapp = await ensureCommunicationIdentityForPairing({
      channel: "whatsapp",
      accountId: "family",
      peerId: "15551230001@s.whatsapp.net",
      identityPhone: "+15125550101",
      env,
    });
    const guest = await ensureCommunicationIdentityForPairing({
      channel: "signal",
      peerId: "+15125550102",
      env,
    });
    expect(whatsapp.identity.id).toBe(signal.identity.id);
    expect(whatsapp.identity.workspace).toBe(signal.identity.workspace);
    expect(guest.identity.id).not.toBe(signal.identity.id);
    expect(guest.identity.workspace).not.toBe(signal.identity.workspace);

    // Simulate a process restart that begins from a stale/unprojected config.
    mocks.config = {
      agents: { list: [{ id: "finn", default: true, workspace: "/trusted" }] },
      commands: { ownerAllowFrom: [] },
      tools: { elevated: { enabled: true, allowFrom: { signal: ["*"] } } },
    } as OpenClawConfig;
    const registry = await reconcileCommunicationIdentityConfig(env);
    expect(registry.adminIdentityId).toBe(signal.identity.id);
    expect(Object.keys(registry.identities)).toHaveLength(2);
    const restoredGuest = mocks.config.agents?.list?.find(
      (agent) => agent.id === guest.identity.memberAgentId,
    );
    expect(restoredGuest?.sandbox).toMatchObject({ mode: "all", backend: "docker" });
    expect(restoredGuest?.tools?.elevated?.enabled).toBe(false);
    expect(mocks.config.commands?.ownerAllowFrom).toEqual([
      "signal:signal-admin-uuid",
      "whatsapp:15551230001@s.whatsapp.net",
    ]);
    expect(mocks.config.tools?.elevated?.allowFrom).toEqual({
      signal: ["signal-admin-uuid"],
      whatsapp: ["15551230001@s.whatsapp.net"],
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked registry before reading attacker-controlled content",
    async () => {
      const registryPath = resolveCommunicationIdentityRegistryPath(env);
      await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
      const external = path.join(tempRoot, "external-registry.json");
      await fs.promises.writeFile(external, "{}\n", "utf8");
      await fs.promises.symlink(external, registryPath);
      await expect(listCommunicationIdentities(env)).rejects.toThrow("non-symlink file");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlink substituted for an identity workspace",
    async () => {
      const ensured = await ensureCommunicationIdentityForPairing({
        channel: "signal",
        peerId: "+15125550101",
        env,
      });
      const external = path.join(tempRoot, "external-workspace");
      await fs.promises.mkdir(external);
      await fs.promises.rm(ensured.identity.workspace, { recursive: true });
      await fs.promises.symlink(external, ensured.identity.workspace);
      await expect(reconcileCommunicationIdentityConfig(env)).rejects.toThrow(
        "not a regular directory",
      );
      await expect(fs.promises.readdir(external)).resolves.toEqual([]);
    },
  );
});
