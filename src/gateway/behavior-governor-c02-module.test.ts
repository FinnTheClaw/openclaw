import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "../security/governor-agent-loop-readonly.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "../security/governor-c02-simple-efficiency-policy.js";
import {
  C02_BEHAVIOR_GOVERNOR_MODULE,
  C02_EVALUATION_SESSION_PREFIX,
} from "./behavior-governor-c02-module.js";

const ACTIVATION = Object.freeze({
  id: C02_SIMPLE_EFFICIENCY_ID,
  mode: "enforce" as const,
  version: C02_SIMPLE_EFFICIENCY_VERSION,
});

function run(sessionKey: string, runId = "run-1"): GovernorAgentLoopRunInput {
  return Object.freeze({
    runId,
    sessionKey,
    sessionId: "session-1",
    agentId: "main",
    workspaceId: "workspace-1",
    channel: "local",
    accountId: "default",
    principalId: "owner",
    conversationId: "conversation-1",
    sourceMessageId: `message-${runId}`,
    prompt: `prompt-${runId}`,
    now: 10,
  });
}

function required(scope: GovernorAgentLoopRunScope | undefined): GovernorAgentLoopRunScope {
  expect(scope).toBeDefined();
  if (!scope) {
    throw new Error("expected C02 scope");
  }
  return scope;
}

async function createRuntime() {
  const factory = await C02_BEHAVIOR_GOVERNOR_MODULE.load();
  return factory(ACTIVATION);
}

describe("C02 behavior governor module", () => {
  it("is explicitly hostless while keeping the normal production profile", async () => {
    expect(C02_BEHAVIOR_GOVERNOR_MODULE.requiresHost).toBe(false);
    const runtime = await createRuntime();
    const scope = required(
      runtime.agentLoop?.resolveRunScope({
        activation: ACTIVATION,
        run: run("agent:main:main"),
      }),
    );

    expect(scope.taskId).toBe("run-1");
    scope.dispose();
    await runtime.close();
  });

  it("activates a local evaluator only for an exact agent-scoped C02 evaluation session", async () => {
    const runtime = await createRuntime();
    const session = `${C02_EVALUATION_SESSION_PREFIX}C02-A-001:0123456789abcdef01234567`;
    const scope = required(
      runtime.agentLoop?.resolveRunScope({
        activation: ACTIVATION,
        run: run(`agent:alistar:${session}`),
      }),
    );

    expect(scope.taskId).toBe("c02-eval-session:C02-A-001:0123456789abcdef01234567");
    expect(
      scope.beforeTool({
        toolCallId: "beta-first",
        toolName: "read",
        args: { path: "/case/C02-A-001/beta.txt" },
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_ACTION_NOT_ELIGIBLE" });

    scope.dispose();
    await runtime.close();
  });

  it("blocks a duplicate evaluation scope before either scope can execute a second tool", async () => {
    const runtime = await createRuntime();
    const session = `${C02_EVALUATION_SESSION_PREFIX}C02-F-001:999999999999999999999999`;
    const first = required(
      runtime.agentLoop?.resolveRunScope({ activation: ACTIVATION, run: run(session, "first") }),
    );
    const duplicate = required(
      runtime.agentLoop?.resolveRunScope({
        activation: ACTIVATION,
        run: run(session, "duplicate"),
      }),
    );
    expect(first.disposition).toBe("runnable");
    expect(duplicate.disposition).toBe("checkpoint_pending");
    expect(
      duplicate.beforeTool({
        toolCallId: "blocked-before-tool",
        toolName: "read",
        args: { path: "/case/C02-F-001/alpha.txt" },
        tool: undefined,
        now: 11,
      }),
    ).toEqual({ kind: "block", reasonCode: "C02_RESTART_REQUIRED" });
    first.dispose();
    duplicate.dispose();
    await runtime.close();
  });

  it("persists the F checkpoint across a module reload without the generic host registration", async () => {
    const session = `${C02_EVALUATION_SESSION_PREFIX}C02-F-001:fedcba9876543210fedcba98`;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c02-module-reload-"));
    const priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      vi.resetModules();
      const firstModule = await import("./behavior-governor-c02-module.js");
      const firstFactory = await firstModule.C02_BEHAVIOR_GOVERNOR_MODULE.load();
      const firstRuntime = await firstFactory(ACTIVATION);
      const first = required(
        firstRuntime.agentLoop?.resolveRunScope({
          activation: ACTIVATION,
          run: run(session, "before-restart"),
        }),
      );
      for (const [toolName, args] of [
        ["read", { path: "/case/C02-F-001/alpha.txt" }],
        ["read", { path: "/case/C02-F-001/beta.txt" }],
      ] as const) {
        const allowed = first.beforeTool({
          toolCallId: toolName,
          toolName,
          args,
          tool: undefined,
          now: 11,
        });
        expect(allowed.kind).toBe("allow");
        await first.afterTool({
          ...(allowed.kind === "allow" ? { ticket: allowed.ticket } : {}),
          toolCallId: toolName,
          toolName,
          result: "ok",
          isError: false,
          now: 12,
        });
      }
      expect(first.disposition).toBe("checkpoint_pending");
      first.dispose();
      await firstRuntime.close();

      vi.resetModules();
      const resumedModule = await import("./behavior-governor-c02-module.js");
      const resumedFactory = await resumedModule.C02_BEHAVIOR_GOVERNOR_MODULE.load();
      const resumedRuntime = await resumedFactory(ACTIVATION);
      const resumed = required(
        resumedRuntime.agentLoop?.resolveRunScope({
          activation: ACTIVATION,
          run: run(session, "after-restart"),
        }),
      );
      expect(
        resumed.beforeTool({
          toolCallId: "aggregate",
          toolName: "exec",
          args: { command: "/usr/bin/python3 -c 'print(3)'" },
          tool: undefined,
          now: 14,
        }),
      ).toMatchObject({ kind: "allow" });
      resumed.dispose();
      await resumedRuntime.close();
    } finally {
      vi.resetModules();
      if (priorStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = priorStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps normal agent-scoped channel keys outside the exact C02 evaluation namespace", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c02-normal-session-"));
    const priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      vi.resetModules();
      const module = await import("./behavior-governor-c02-module.js");
      const factory = await module.C02_BEHAVIOR_GOVERNOR_MODULE.load();
      const runtime = await factory(ACTIVATION);
      for (const sessionKey of [
        "agent:main:main",
        "agent:main:signal:group:friends",
        "agent:main:imessage:chat:family",
        "signal:group:friends",
      ]) {
        const value = required(
          runtime.agentLoop?.resolveRunScope({
            activation: ACTIVATION,
            run: run(sessionKey, `normal-${sessionKey}`),
          }),
        );
        expect(value.taskId).toBe(`normal-${sessionKey}`);
        value.dispose();
      }
      expect(fs.existsSync(path.join(stateDir, "governor", "c02-eval-restarts"))).toBe(false);
      await runtime.close();
    } finally {
      vi.resetModules();
      if (priorStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = priorStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
