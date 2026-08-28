import { describe, expect, it } from "vitest";
import {
  advanceGovernorC05FailureReplan,
  recoverGovernorC05FailureReplan,
} from "../../security/governor-agent-loop-c05-failure-replan.js";
import type { GovernorController } from "../../tasks/governor/controller.js";
import {
  createFailureReplanModule,
  FAILURE_REPLAN_MODULE_ID,
  FAILURE_REPLAN_MODULE_VERSION,
} from "./failure-replan.js";

type CrashPoint = "checkpoint" | "plan" | "start";

function controller(params: { state?: string; crashAt?: CrashPoint; mutate?: boolean } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const task = {
    taskId: "gtask_c05",
    scopeKey: "scope_c05",
    state: params.state ?? "EXECUTING",
    planVersion: 1,
    objectiveRevision: 3,
    executionGeneration: 7,
    contract: {
      completionCriteria: [
        { criterionId: "mutate", description: "Mutate" },
        { criterionId: "verify", description: "Verify", dependsOnCriteria: ["mutate"] },
      ],
    },
  } as Record<string, unknown>;
  const effect = {
    taskId: task.taskId,
    effectId: "effect_c05",
    criterionId: "mutate",
    capability: "fixture.observe",
    mutating: params.mutate ?? false,
    objectiveRevision: task.objectiveRevision,
    planVersion: task.planVersion,
    executionGeneration: task.executionGeneration,
    outcome: {
      transport: "failed",
      semantic: "transient_failure",
      sideEffect: params.mutate ? "unknown" : "none",
    },
    reconcileRequired: Boolean(params.mutate),
  };
  let crashAt = params.crashAt;
  const fake = {
    store: {
      loadTask: () => task,
      listEffects: () => [effect],
      listEvents: () => events,
    },
    requestRuntimeReplan: (_id: string, _now: number, request: Record<string, unknown>) => {
      task.state = "REPLAN_REQUIRED";
      events.push({
        eventType: "runtime_replan_requested",
        taskId: task.taskId,
        scopeKey: task.scopeKey,
        objectiveRevision: task.objectiveRevision,
        payload: request,
      });
    },
    recordCheckpoint: (request: Record<string, unknown>) => {
      if (crashAt === "checkpoint") {
        throw new Error("CRASH_CHECKPOINT");
      }
      events.push({
        eventType: "checkpoint_recorded",
        payload: { checkpointId: request.checkpointId },
      });
    },
    preparePlan: (request: { plan: { steps: readonly { criterionIds: readonly string[] }[] } }) => {
      if (crashAt === "plan") {
        throw new Error("CRASH_PLAN");
      }
      task.planVersion = Number(task.planVersion) + 1;
      task.state = "READY";
      (task as Record<string, unknown>).preparedCriteria = request.plan.steps.flatMap(
        (step) => step.criterionIds,
      );
      return task;
    },
    startExecution: () => {
      if (crashAt === "start") {
        throw new Error("CRASH_START");
      }
      task.state = "EXECUTING";
    },
  };
  return {
    controller: fake as unknown as GovernorController,
    events,
    task,
    effect,
    resume: () => {
      crashAt = undefined;
    },
  };
}

async function enforce() {
  return createFailureReplanModule()({
    activationId: {},
    id: FAILURE_REPLAN_MODULE_ID,
    version: FAILURE_REPLAN_MODULE_VERSION,
    mode: "enforce",
  });
}

describe("C05 failure replan module", () => {
  it("is import-inert and persists the complete fenced C05 boundary before planning", async () => {
    const fixture = controller();
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 10,
      }),
    ).toBeUndefined();
    const runtime = await enforce();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", fromPlanVersion: 1, planVersion: 2 });
    expect(fixture.events[0]?.payload).toMatchObject({
      c05FailureReplan: {
        taskId: "gtask_c05",
        sourceEffectId: "effect_c05",
        fromPlanVersion: 1,
        objectiveRevision: 3,
        executionGeneration: 7,
        expectedState: "REPLAN_REQUIRED",
      },
    });
    await runtime.close();
  });

  it.each(["checkpoint", "plan", "start"] as const)(
    "recovers exactly once across the durable %s crash boundary",
    async (crashAt) => {
      const fixture = controller({ crashAt });
      const runtime = await enforce();
      expect(() =>
        advanceGovernorC05FailureReplan({
          controller: fixture.controller,
          taskId: "gtask_c05" as never,
          sourceEffectId: "effect_c05",
          now: 10,
        }),
      ).toThrow();
      fixture.resume();
      expect(
        recoverGovernorC05FailureReplan({
          controller: fixture.controller,
          taskId: "gtask_c05" as never,
          now: 20,
        }),
      ).toMatchObject({ kind: "replanned", planVersion: 2 });
      expect(
        recoverGovernorC05FailureReplan({
          controller: fixture.controller,
          taskId: "gtask_c05" as never,
          now: 30,
        }),
      ).toEqual({ kind: "already_replanned" });
      expect(fixture.task.planVersion).toBe(2);
      await runtime.close();
    },
  );

  it("recovers the EXECUTING-after-observation window and blocks ambiguous physical repeats", async () => {
    const fixture = controller({ mutate: true });
    const runtime = await enforce();
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned" });
    expect(fixture.task.preparedCriteria).toEqual(["verify"]);
    await runtime.close();
  });

  it.each(["PLANNING", "REPLAN_REQUIRED"])(
    "ignores foreign %s work without a C05 boundary",
    async (state) => {
      const fixture = controller({ state });
      const runtime = await enforce();
      expect(
        recoverGovernorC05FailureReplan({
          controller: fixture.controller,
          taskId: "gtask_c05" as never,
          now: 10,
        }),
      ).toBeUndefined();
      expect(fixture.task.planVersion).toBe(1);
      await runtime.close();
    },
  );

  it("rejects authorization-scope boundary mismatch", async () => {
    const fixture = controller({ crashAt: "checkpoint" });
    const runtime = await enforce();
    expect(() =>
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toThrow();
    fixture.resume();
    const event = fixture.events[0]!;
    (event as { scopeKey: string }).scopeKey = "foreign";
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 20,
      }),
    ).toBeUndefined();
    expect(fixture.task.planVersion).toBe(1);
    await runtime.close();
  });

  it.each([
    ["task", "taskId", "foreign-task"],
    ["plan", "fromPlanVersion", 99],
    ["effect", "sourceEffectId", "foreign-effect"],
  ])("rejects C05 %s boundary mismatch", async (_label, field, value) => {
    const fixture = controller({ crashAt: "checkpoint" });
    const runtime = await enforce();
    expect(() =>
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toThrow();
    fixture.resume();
    const payload = (fixture.events[0]!.payload as { c05FailureReplan: Record<string, unknown> })
      .c05FailureReplan;
    payload[field] = value;
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 20,
      }),
    ).toBeUndefined();
    expect(fixture.task.planVersion).toBe(1);
    await runtime.close();
  });

  it("keeps parallel lifecycle activations isolated across close and shadow", async () => {
    const first = await enforce();
    const second = await enforce();
    await first.close();
    const fixture = controller();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned" });
    await second.close();
    const shadow = await createFailureReplanModule()({
      activationId: {},
      id: FAILURE_REPLAN_MODULE_ID,
      version: FAILURE_REPLAN_MODULE_VERSION,
      mode: "shadow",
    });
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 20,
      }),
    ).toBeUndefined();
    await shadow.close();
  });
});
