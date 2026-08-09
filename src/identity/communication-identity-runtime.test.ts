import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIO } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyCommunicationIdentityConfig } from "./communication-identity-policy.js";
import {
  COMMUNICATION_IDENTITY_REGISTRY_FILE,
  createCommunicationIdentityRegistryForTest,
  planCommunicationIdentityApproval,
  type CommunicationIdentityRegistry,
} from "./communication-identity-registry.js";
import { applyCommunicationIdentityRuntimeOverlay } from "./communication-identity-runtime.js";

const ADMIN_PHONE = "+15125550101";
const GUEST_PHONE = "+15125550102";

async function withStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-runtime-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function registryFixture(stateDir: string): CommunicationIdentityRegistry {
  const admin = planCommunicationIdentityApproval({
    registry: createCommunicationIdentityRegistryForTest(),
    stateDir,
    channel: "signal",
    peerId: ADMIN_PHONE,
  });
  return planCommunicationIdentityApproval({
    registry: admin.registry,
    stateDir,
    channel: "whatsapp",
    peerId: GUEST_PHONE,
  }).registry;
}

function baseConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "finn", default: true, workspace: "/trusted/admin" }] },
    tools: { profile: "full" },
  } as OpenClawConfig;
}

async function writeRegistry(
  stateDir: string,
  registry: CommunicationIdentityRegistry,
  suffix = "",
): Promise<string> {
  const directory = path.join(stateDir, "identity");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
  }
  const filePath = path.join(directory, `${COMMUNICATION_IDENTITY_REGISTRY_FILE}${suffix}`);
  await fs.writeFile(filePath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  return filePath;
}

describe("communication identity runtime overlay", () => {
  it("repairs weakened managed policy on every runtime config load", async () => {
    await withStateDir(async (stateDir) => {
      const registry = registryFixture(stateDir);
      await writeRegistry(stateDir, registry);
      const projected = applyCommunicationIdentityConfig({
        config: baseConfig(),
        registry,
        stateDir,
      });
      const guestId = Object.values(registry.identities).find(
        (identity) => identity.phone === GUEST_PHONE,
      )?.memberAgentId;
      const guest = projected.agents?.list?.find((agent) => agent.id === guestId);
      if (!guest) {
        throw new Error("Guest fixture missing.");
      }
      guest.sandbox = { mode: "off" };
      guest.tools = { profile: "full", fs: { workspaceOnly: false } };
      projected.tools = {
        ...projected.tools,
        elevated: { enabled: true, allowFrom: { signal: ["*"] } },
      };

      const repaired = applyCommunicationIdentityRuntimeOverlay({ config: projected, stateDir });
      const repairedGuest = repaired.agents?.list?.find((agent) => agent.id === guestId);
      expect(repairedGuest?.sandbox).toMatchObject({ mode: "all", backend: "docker" });
      expect(repairedGuest?.tools?.fs?.workspaceOnly).toBe(true);
      expect(repairedGuest?.tools?.elevated?.enabled).toBe(false);
      expect(repaired.tools?.elevated?.allowFrom).toEqual({ signal: [ADMIN_PHONE] });
    });
  });

  it("is enforced by the real config loader rather than only by direct callers", async () => {
    await withStateDir(async (stateDir) => {
      const registry = registryFixture(stateDir);
      await writeRegistry(stateDir, registry);
      const weakened = applyCommunicationIdentityConfig({
        config: baseConfig(),
        registry,
        stateDir,
      });
      const guestId = Object.values(registry.identities).find(
        (identity) => identity.phone === GUEST_PHONE,
      )?.memberAgentId;
      const guest = weakened.agents?.list?.find((agent) => agent.id === guestId);
      if (!guest || !guestId) {
        throw new Error("Guest fixture missing.");
      }
      guest.sandbox = { mode: "off" };
      guest.tools = { profile: "full", fs: { workspaceOnly: false } };

      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, `${JSON.stringify(weakened, null, 2)}\n`, { mode: 0o600 });
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };
      const loaded = createConfigIO({
        env,
        homedir: () => stateDir,
        pluginValidation: "skip",
        shellEnvFallback: "defer",
      }).loadConfig();
      const loadedGuest = loaded.agents?.list?.find((agent) => agent.id === guestId);
      expect(loadedGuest?.sandbox).toMatchObject({ mode: "all", backend: "docker" });
      expect(loadedGuest?.tools?.fs?.workspaceOnly).toBe(true);
      expect(loadedGuest?.tools?.elevated?.enabled).toBe(false);
    });
  });

  it("uses the durable pending transaction until canonical commit completes", async () => {
    await withStateDir(async (stateDir) => {
      const canonical = planCommunicationIdentityApproval({
        registry: createCommunicationIdentityRegistryForTest(),
        stateDir,
        channel: "signal",
        peerId: ADMIN_PHONE,
      }).registry;
      const pending = planCommunicationIdentityApproval({
        registry: canonical,
        stateDir,
        channel: "whatsapp",
        peerId: GUEST_PHONE,
      }).registry;
      await writeRegistry(stateDir, canonical);
      await writeRegistry(stateDir, pending, ".pending");

      const overlaid = applyCommunicationIdentityRuntimeOverlay({
        config: baseConfig(),
        stateDir,
      });
      const pendingGuest = Object.values(pending.identities).find(
        (identity) => identity.phone === GUEST_PHONE,
      );
      expect(overlaid.agents?.list?.some((agent) => agent.id === pendingGuest?.memberAgentId)).toBe(
        true,
      );
    });
  });

  it("fails closed when managed policy loses its protected registry", async () => {
    await withStateDir(async (stateDir) => {
      const registry = registryFixture(stateDir);
      const managed = applyCommunicationIdentityConfig({
        config: baseConfig(),
        registry,
        stateDir,
      });
      expect(() => applyCommunicationIdentityRuntimeOverlay({ config: managed, stateDir })).toThrow(
        "protected registry is missing",
      );
    });
  });

  it("rejects a registry exposed to other local users", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withStateDir(async (stateDir) => {
      const filePath = await writeRegistry(stateDir, registryFixture(stateDir));
      await fs.chmod(filePath, 0o644);
      expect(() =>
        applyCommunicationIdentityRuntimeOverlay({ config: baseConfig(), stateDir }),
      ).toThrow("must not be accessible by group or other users");
    });
  });
});
