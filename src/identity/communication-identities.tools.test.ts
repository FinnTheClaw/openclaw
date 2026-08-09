import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import "../agents/test-helpers/fast-bash-tools.js";
import "../agents/test-helpers/fast-coding-tools.js";
import "../agents/test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { registerSandboxBackend } from "../agents/sandbox/backend.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import {
  applyCommunicationIdentityConfig,
  createCommunicationIdentityRegistryForTest,
  planCommunicationIdentityApproval,
} from "./communication-identities.js";

const ADMIN_PHONE = "+15125550101";
const GUEST_PHONE = "+15125550102";

function projectedConfig(stateDir: string) {
  const empty = createCommunicationIdentityRegistryForTest();
  const admin = planCommunicationIdentityApproval({
    registry: empty,
    stateDir,
    channel: "signal",
    peerId: ADMIN_PHONE,
  });
  const guest = planCommunicationIdentityApproval({
    registry: admin.registry,
    stateDir,
    channel: "whatsapp",
    peerId: GUEST_PHONE,
  });
  const config = applyCommunicationIdentityConfig({
    config: {
      agents: {
        list: [
          {
            id: "finn",
            default: true,
            workspace: path.join(stateDir, "admin-workspace"),
          },
        ],
      },
    } as OpenClawConfig,
    registry: guest.registry,
    stateDir,
  });
  return { config, guest };
}

function toolNames(tools: ReturnType<typeof createOpenClawCodingTools>): string[] {
  return tools.map((tool) => tool.name).toSorted();
}

describe("communication identity effective tools", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("does not re-expose host or cross-session tools after policy composition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-tools-"));
    try {
      const { config, guest } = projectedConfig(root);
      const guestTools = createOpenClawCodingTools({
        config,
        agentId: guest.identity.memberAgentId,
        sessionKey: `agent:${guest.identity.memberAgentId}:whatsapp:direct:${GUEST_PHONE}`,
        workspaceDir: guest.identity.workspace,
        agentDir: guest.identity.agentDir,
      });
      const quarantineTools = createOpenClawCodingTools({
        config,
        agentId: "communication-quarantine",
        sessionKey: "agent:communication-quarantine:signal:direct:unknown",
        workspaceDir: path.join(root, "quarantine"),
        agentDir: path.join(root, "quarantine-agent"),
      });
      const adminTools = createOpenClawCodingTools({
        config,
        agentId: "finn",
        sessionKey: "agent:finn:main",
        workspaceDir: path.join(root, "admin-workspace"),
        agentDir: path.join(root, "admin-agent"),
      });

      const guestNames = toolNames(guestTools);
      const permittedGuestTools = new Set([
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
        "session_status",
      ]);
      expect(guestNames.length).toBeGreaterThan(0);
      expect(guestNames.every((name) => permittedGuestTools.has(name))).toBe(true);
      expect(guestNames).toEqual(expect.arrayContaining(["read", "write", "exec"]));
      expect(guestNames).not.toEqual(
        expect.arrayContaining([
          "gateway",
          "nodes",
          "cron",
          "message",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "subagents",
          "agents_list",
        ]),
      );
      expect(toolNames(quarantineTools)).toEqual(["session_status"]);

      const adminNames = toolNames(adminTools);
      expect(adminNames).toEqual(expect.arrayContaining(["read", "write", "exec"]));
      expect(adminNames.some((name) => !permittedGuestTools.has(name))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("enforces guest workspace-only writes while the admin remains unrestricted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-fs-"));
    try {
      const { config, guest } = projectedConfig(root);
      await fs.mkdir(guest.identity.workspace, { recursive: true });
      const adminWorkspace = path.join(root, "admin-workspace");
      await fs.mkdir(adminWorkspace, { recursive: true });
      const outside = path.join(root, "outside-guest-workspace.txt");

      const guestWrite = createOpenClawCodingTools({
        config,
        agentId: guest.identity.memberAgentId,
        sessionKey: `agent:${guest.identity.memberAgentId}:whatsapp:direct:${GUEST_PHONE}`,
        workspaceDir: guest.identity.workspace,
        agentDir: guest.identity.agentDir,
      }).find((tool) => tool.name === "write");
      const adminWrite = createOpenClawCodingTools({
        config,
        agentId: "finn",
        sessionKey: "agent:finn:main",
        workspaceDir: adminWorkspace,
        agentDir: path.join(root, "admin-agent"),
      }).find((tool) => tool.name === "write");
      if (!guestWrite || !adminWrite) {
        throw new Error("Expected write tools for both admin and isolated member.");
      }

      await expect(
        guestWrite.execute("guest-escape", { path: outside, content: "must-not-write" }),
      ).rejects.toThrow(/escapes|outside|workspace/i);
      await adminWrite.execute("admin-write", { path: outside, content: "admin-ok" });
      expect(await fs.readFile(outside, "utf8")).toBe("admin-ok");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of falling back to the host when the sandbox is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-sandbox-"));
    const restore = registerSandboxBackend("docker", async () => {
      throw new Error("injected identity sandbox unavailable");
    });
    try {
      const { config, guest } = projectedConfig(root);
      await expect(
        resolveSandboxContext({
          config,
          sessionKey: `agent:${guest.identity.memberAgentId}:signal:direct:${GUEST_PHONE}`,
          workspaceDir: guest.identity.workspace,
        }),
      ).rejects.toThrow("injected identity sandbox unavailable");
    } finally {
      restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
