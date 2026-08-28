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

function controller(state = "EXECUTING", planVersion = 1) {
  const events: Array<{ eventType: string; payload: unknown }> = [];
  const task = {
    taskId: "gtask_c05",
    state,
    planVersion,
    executionGeneration: 7,
    contract: { completionCriteria: [] },
  } as Record<string, unknown>;
  const effect = {
    effectId: "effect_c05",
    capability: "fixture.observe",
    outcome: { transport: "failed", semantic: "transient_failure" },
  };
  const fake = {
    store: {
      loadTask: () => task,
      loadEffect: () => effect,
      listEvents: () => events,
    },
    requestRuntimeReplan: (_id: string, _now: number, request: { sourceEffectId: string }) => {
      task.state = "REPLAN_REQUIRED";
      events.push({ eventType: "runtime_replan_requested", payload: request });
    },
    recordCheckpoint: () => undefined,
    preparePlan: () => {
      task.planVersion = Number(task.planVersion) + 1;
      task.state = "READY";
      return task;
    },
    startExecution: () => {
      task.state = "EXECUTING";
    },
  };
  return { controller: fake as unknown as GovernorController, events, task };
}

describe("C05 failure replan module", () => {
  it("is import-inert and only the exact selected factory enables N to N+1", async () => {
    const fixture = controller();
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toEqual({ kind: "not_eligible" });
    const runtime = await createFailureReplanModule()({
      id: FAILURE_REPLAN_MODULE_ID,
      version: FAILURE_REPLAN_MODULE_VERSION,
      mode: "enforce",
    });
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", fromPlanVersion: 1, planVersion: 2 });
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 20,
      }),
    ).toEqual({ kind: "already_replanned" });
    expect(fixture.events).toHaveLength(1);
    await runtime.close();
  });

  it("repairs PLANNING once and leaves an already-ready restart transparent", async () => {
    const fixture = controller("PLANNING", 1);
    const runtime = await createFailureReplanModule()({
      id: FAILURE_REPLAN_MODULE_ID,
      version: FAILURE_REPLAN_MODULE_VERSION,
      mode: "enforce",
    });
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 10,
      }),
    ).toMatchObject({ kind: "replanned", planVersion: 2 });
    expect(
      recoverGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        now: 20,
      }),
    ).toBeUndefined();
    await runtime.close();
  });

  it("keeps shadow selected behavior observational and closes without coupling", async () => {
    const fixture = controller();
    const runtime = await createFailureReplanModule()({
      id: FAILURE_REPLAN_MODULE_ID,
      version: FAILURE_REPLAN_MODULE_VERSION,
      mode: "shadow",
    });
    expect(
      advanceGovernorC05FailureReplan({
        controller: fixture.controller,
        taskId: "gtask_c05" as never,
        sourceEffectId: "effect_c05",
        now: 10,
      }),
    ).toEqual({ kind: "not_eligible" });
    await runtime.close();
    expect(fixture.events).toEqual([]);
  });
});
