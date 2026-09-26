import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRuntimeTaskFlow } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterRunner } from "./lobster-runner.js";
import {
  type BoundTaskFlow,
  resumeManagedLobsterFlow,
  runManagedLobsterFlow,
} from "./lobster-taskflow.js";
import { createLobsterTool } from "./lobster-tool.js";
import { createFakeTaskFlow } from "./taskflow-test-helpers.js";

const success: Awaited<ReturnType<LobsterRunner["run"]>> = {
  ok: true,
  status: "ok",
  output: [],
  requiresApproval: null,
};
const approval: Awaited<ReturnType<LobsterRunner["run"]>> = {
  ok: true,
  status: "needs_approval",
  output: [],
  requiresApproval: {
    type: "approval_request",
    prompt: "Approve?",
    items: [{ id: "item-1" }],
    resumeToken: "resume-1",
  },
};

function runnerFor(envelope: Awaited<ReturnType<LobsterRunner["run"]>>): LobsterRunner {
  return { run: vi.fn().mockResolvedValue(envelope) };
}

function realFlow(suffix: string): BoundTaskFlow {
  return createRuntimeTaskFlow().bindSession({
    sessionKey: `agent:main:cp70-lb-${suffix}`,
  });
}

function runParams(taskFlow: BoundTaskFlow, runner: LobsterRunner) {
  return {
    taskFlow,
    config: {},
    runner,
    runnerParams: {
      action: "run" as const,
      pipeline: "noop",
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxStdoutBytes: 4096,
    },
    controllerId: "tests/cp70-lobster",
    goal: "Checkpoint 70 Lobster flow",
  };
}

function resumeParams(
  taskFlow: BoundTaskFlow,
  runner: LobsterRunner,
  flowId: string,
  expectedRevision: number,
) {
  return {
    taskFlow,
    config: {},
    runner,
    runnerParams: {
      action: "resume" as const,
      token: "resume-1",
      approve: true,
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxStdoutBytes: 4096,
    },
    flowId,
    expectedRevision,
  };
}

function requireFlow(taskFlow: BoundTaskFlow) {
  const flow = taskFlow.findLatest();
  if (!flow) {
    throw new Error("Expected a managed TaskFlow");
  }
  return flow;
}

function deferredRunner(envelope: Awaited<ReturnType<LobsterRunner["run"]>>) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner: LobsterRunner = {
    run: vi.fn(async () => {
      enter();
      await held;
      return envelope;
    }),
  };
  return { runner, entered, release };
}

describe("CP70 Lobster finalize mutation acceptance", () => {
  it("CP70-LB01 real run finish applies and succeeds", async () => {
    const taskFlow = realFlow("01");
    const result = await runManagedLobsterFlow(runParams(taskFlow, runnerFor(success)));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.mutation).toMatchObject({ applied: true });
    expect(taskFlow.get(result.flow.flowId)?.status).toBe("succeeded");
    expect(taskFlow.get(result.flow.flowId)?.revision).toBe(result.flow.revision + 1);
  });

  it("CP70-LB02 real run waiting applies and preserves approval", async () => {
    const taskFlow = realFlow("02");
    const result = await runManagedLobsterFlow(runParams(taskFlow, runnerFor(approval)));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.mutation).toMatchObject({ applied: true });
    expect(taskFlow.get(result.flow.flowId)?.status).toBe("waiting");
    expect(taskFlow.get(result.flow.flowId)?.waitJson).toMatchObject({
      kind: "lobster_approval",
      prompt: "Approve?",
      resumeToken: "resume-1",
    });
  });

  it("CP70-LB03 real resume finish applies and succeeds", async () => {
    const taskFlow = realFlow("03");
    const waiting = taskFlow.createManaged({
      controllerId: "tests/cp70-lobster",
      goal: "Resume success",
      status: "waiting",
    });
    const result = await resumeManagedLobsterFlow(
      resumeParams(taskFlow, runnerFor(success), waiting.flowId, waiting.revision),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.mutation).toMatchObject({ applied: true });
    expect(taskFlow.get(waiting.flowId)?.status).toBe("succeeded");
    expect(taskFlow.get(waiting.flowId)?.revision).toBe(waiting.revision + 2);
  });

  it("CP70-LB04 real resume waiting applies new approval", async () => {
    const taskFlow = realFlow("04");
    const waiting = taskFlow.createManaged({
      controllerId: "tests/cp70-lobster",
      goal: "Resume waiting",
      status: "waiting",
    });
    const result = await resumeManagedLobsterFlow(
      resumeParams(taskFlow, runnerFor(approval), waiting.flowId, waiting.revision),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.mutation).toMatchObject({ applied: true });
    expect(taskFlow.get(waiting.flowId)?.status).toBe("waiting");
    expect(taskFlow.get(waiting.flowId)?.waitJson).toMatchObject({ resumeToken: "resume-1" });
  });

  it("CP70-LB05 real requestCancel revision conflict rejects finish", async () => {
    const taskFlow = realFlow("05");
    const held = deferredRunner(success);
    const pending = runManagedLobsterFlow(runParams(taskFlow, held.runner));
    await held.entered;
    const flow = requireFlow(taskFlow);
    const cancel = taskFlow.requestCancel({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
    });
    expect(cancel.applied).toBe(true);
    held.release();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected revision conflict");
    }
    expect(result.mutation).toMatchObject({ applied: false, code: "revision_conflict" });
    expect(result.error.message).toMatch(/revision_conflict/u);
    expect(taskFlow.get(flow.flowId)?.status).not.toBe("succeeded");
    expect(taskFlow.get(flow.flowId)?.revision).toBe(flow.revision + 1);
  });

  it("CP70-LB06 real requestCancel revision conflict rejects waiting", async () => {
    const taskFlow = realFlow("06");
    const held = deferredRunner(approval);
    const pending = runManagedLobsterFlow(runParams(taskFlow, held.runner));
    await held.entered;
    const flow = requireFlow(taskFlow);
    const cancel = taskFlow.requestCancel({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
    });
    expect(cancel.applied).toBe(true);
    held.release();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected revision conflict");
    }
    expect(result.mutation).toMatchObject({ applied: false, code: "revision_conflict" });
    expect(taskFlow.get(flow.flowId)?.status).not.toBe("waiting");
    expect(taskFlow.get(flow.flowId)?.revision).toBe(flow.revision + 1);
  });

  it("CP70-LB07 controlled not_found finish is not success", async () => {
    const taskFlow = createFakeTaskFlow({
      finish: vi.fn().mockReturnValue({ applied: false, code: "not_found" }),
    });
    const result = await runManagedLobsterFlow(runParams(taskFlow, runnerFor(success)));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected not_found");
    }
    expect(result.mutation).toEqual({ applied: false, code: "not_found" });
    expect(result.error.message).toMatch(/not_found/u);
    expect(taskFlow.fail).not.toHaveBeenCalled();
  });

  it("CP70-LB08 controlled persist_failed waiting retains current", async () => {
    const current = { flowId: "flow-1", revision: 2, status: "queued" };
    const mutation = { applied: false, code: "persist_failed", current };
    const taskFlow = createFakeTaskFlow({
      setWaiting: vi.fn().mockReturnValue(mutation),
    });
    const result = await runManagedLobsterFlow(runParams(taskFlow, runnerFor(approval)));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected persist_failed");
    }
    expect(result.mutation).toBe(mutation);
    expect(result.error.message).toMatch(/persist_failed/u);
    expect(taskFlow.fail).not.toHaveBeenCalled();
  });

  it("CP70-LB09 real runner error still fails the flow", async () => {
    const taskFlow = realFlow("09");
    const runner = runnerFor({
      ok: false,
      error: { type: "runtime_error", message: "boom" },
    });
    const result = await runManagedLobsterFlow(runParams(taskFlow, runner));
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected runner failure");
    }
    expect(result.error.message).toBe("boom");
    expect(taskFlow.get(result.flow?.flowId ?? "")?.status).toBe("failed");
  });

  it("CP70-LB10 controlled caller projects rejected finish as error", async () => {
    const taskFlow = createFakeTaskFlow({
      finish: vi.fn().mockReturnValue({ applied: false, code: "revision_conflict" }),
    });
    const api: OpenClawPluginApi = createTestPluginApi({
      id: "lobster",
      name: "lobster",
      source: "test",
      runtime: { version: "test" } as OpenClawPluginApi["runtime"],
      resolvePath: (value) => value,
    });
    const tool = createLobsterTool(api, { taskFlow, runner: runnerFor(success) });
    await expect(
      tool.execute("cp70-lb10", {
        action: "run",
        pipeline: "noop",
        flowControllerId: "tests/cp70-lobster",
        flowGoal: "Caller error projection",
      }),
    ).rejects.toThrow(/TaskFlow completion failed: revision_conflict/u);
  });
});
