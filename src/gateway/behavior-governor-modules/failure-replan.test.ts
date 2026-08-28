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
type SideEffect = "not_applicable" | "none" | "applied" | "unknown";

function controller(
  params: { state?: string; crashAt?: CrashPoint; mutate?: boolean; sideEffect?: SideEffect } = {},
) {
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
      sideEffect: params.sideEffect ?? (params.mutate ? "unknown" : "none"),
    },
    reconcileRequired: Boolean(params.mutate),
  };
  const effects = [effect];
  let crashAt = params.crashAt;
  let prepareCalls = 0;
  let startCalls = 0;
  const fake = {
    store: {
      loadTask: () => task,
      listEffects: () => effects,
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
      prepareCalls += 1;
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
      startCalls += 1;
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
    effects,
    get calls() {
      return { prepare: prepareCalls, start: startCalls };
    },
    addLaterFailure: (effectId = "effect_c05_later", criterionId = "verify") => {
      effects.push({
        ...effect,
        effectId,
        criterionId,
        planVersion: task.planVersion,
      });
    },
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

  it("does not reintroduce a confirmed mutating criterion", async () => {
    const fixture = controller({ mutate: true, sideEffect: "applied" });
    const runtime = await enforce();
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", planVersion: 2 });
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
    ["criterion", "sourceCriterionId", "verify"],
    ["objective", "objectiveRevision", 99],
    ["generation", "executionGeneration", 99],
    ["state", "expectedState", "EXECUTING"],
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

  it("gives a later distinct failure its own N to N+1 boundary", async () => {
    const fixture = controller();
    const runtime = await enforce();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", fromPlanVersion: 1, planVersion: 2 });
    fixture.addLaterFailure();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05_later",
        now: 20,
      }),
    ).toMatchObject({ kind: "replanned", fromPlanVersion: 2, planVersion: 3 });
    expect(fixture.task.planVersion).toBe(3);
    await runtime.close();
  });

  it("fails closed for multiple current failures despite a completed prior boundary", async () => {
    const fixture = controller();
    const runtime = await enforce();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", planVersion: 2 });
    fixture.addLaterFailure("effect_c05_first_current");
    fixture.addLaterFailure("effect_c05_second_current");
    const before = { calls: fixture.calls, eventCount: fixture.events.length };
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 20,
      }),
    ).toBeUndefined();
    expect(fixture.task).toMatchObject({ planVersion: 2, state: "EXECUTING" });
    expect(fixture.calls).toEqual(before.calls);
    expect(fixture.events).toHaveLength(before.eventCount);
    expect(fixture.effects.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: expect.objectContaining({ semantic: "transient_failure" }),
        }),
        expect.objectContaining({
          outcome: expect.objectContaining({ semantic: "transient_failure" }),
        }),
      ]),
    );
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
