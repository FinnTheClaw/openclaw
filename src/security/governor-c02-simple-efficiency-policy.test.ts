import { describe, expect, it } from "vitest";
import {
  C02_FEATURE_PROFILE,
  C02_CRITERIA_TEMPLATE,
  C02_COMPLETION_VERIFICATION,
  C02_MAX_TURNS,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  C02_TRAJECTORY_SCHEMA,
  evaluateGovernorC02Policy,
  governorC02RunBindingDigest,
  governorC02ToolRegistryDigest,
  prepareGovernorC02Run,
  type GovernorC02Criterion,
  type GovernorC02PreparedRun,
  type GovernorC02RunBindingMaterial,
} from "./governor-c02-simple-efficiency-policy.js";

function graph(satisfied: readonly string[] = []): readonly GovernorC02Criterion[] {
  const done = new Set(satisfied);
  return [
    {
      criterionId: "c02-observe-a",
      action: "observe",
      dependsOn: [],
      satisfied: done.has("c02-observe-a"),
    },
    {
      criterionId: "c02-observe-b",
      action: "observe",
      dependsOn: [],
      satisfied: done.has("c02-observe-b"),
    },
    {
      criterionId: "c02-aggregate",
      action: "aggregate",
      dependsOn: ["c02-observe-a", "c02-observe-b"],
      satisfied: done.has("c02-aggregate"),
    },
  ];
}

function material(
  overrides: Partial<GovernorC02RunBindingMaterial> = {},
): GovernorC02RunBindingMaterial {
  const registeredTools = [
    {
      toolName: "read" as const,
      implementationId: "installed-tool:read",
      toolDefinitionDigest: "a".repeat(64),
      canonicalTargetPrefixes: ["campaign://c02/observations"],
    },
    {
      toolName: "exec" as const,
      implementationId: "installed-tool:exec",
      toolDefinitionDigest: "b".repeat(64),
      canonicalTargetPrefixes: ["campaign://c02/aggregate"],
    },
  ];
  return {
    requestId: "run-1",
    sessionKey: "session-1",
    hostDescriptorDigest: "c".repeat(64),
    hostToolRegistryDigest: governorC02ToolRegistryDigest(registeredTools),
    registeredTools,
    bindings: [
      {
        toolName: "read",
        criterionId: "c02-observe-a",
        criterionArgument: "path",
        criterionValue: "/case/alpha.txt",
        canonicalTarget: "campaign://c02/observations",
        implementationId: "installed-tool:read",
        toolDefinitionDigest: "a".repeat(64),
      },
      {
        toolName: "read",
        criterionId: "c02-observe-b",
        criterionArgument: "path",
        criterionValue: "/case/beta.txt",
        canonicalTarget: "campaign://c02/observations",
        implementationId: "installed-tool:read",
        toolDefinitionDigest: "a".repeat(64),
      },
      {
        toolName: "exec",
        criterionId: "c02-aggregate",
        criterionArgument: "command",
        criterionValue: "/usr/bin/python3 -c 'print(3)'",
        canonicalTarget: "campaign://c02/aggregate",
        implementationId: "installed-tool:exec",
        toolDefinitionDigest: "b".repeat(64),
      },
    ],
    ...overrides,
  };
}

function prepared(overrides: Partial<GovernorC02RunBindingMaterial> = {}): GovernorC02PreparedRun {
  const value = material(overrides);
  return prepareGovernorC02Run({ ...value, runBindingDigest: governorC02RunBindingDigest(value) });
}

function evaluate(
  run: GovernorC02PreparedRun,
  criteria: readonly GovernorC02Criterion[],
  attemptedCriterionId?: string,
) {
  return evaluateGovernorC02Policy({
    run,
    projectionRequestId: run.requestId,
    projectionRunBindingDigest: run.runBindingDigest,
    criteria,
    attemptedCriterionId,
  });
}

describe("C02 simple-efficiency v1 policy", () => {
  it("publishes only the exact action-efficiency claim", () => {
    expect(C02_SIMPLE_EFFICIENCY_ID).toBe("c02-simple-efficiency");
    expect(C02_SIMPLE_EFFICIENCY_VERSION).toBe("v1");
    expect(C02_TRAJECTORY_SCHEMA).toBe("openclaw.behavior-governor-trajectory/v1");
    expect(C02_MAX_TURNS).toBe(8);
    expect(C02_COMPLETION_VERIFICATION).toBe("none");
    expect(C02_CRITERIA_TEMPLATE.map((criterion) => criterion.criterionId)).toEqual([
      "c02-observe-a",
      "c02-observe-b",
      "c02-aggregate",
    ]);
    expect(C02_FEATURE_PROFILE).toEqual({
      redundant_action_suppression: true,
      eligible_next_steering: true,
      request_bound_trajectory: true,
      action_sequence: ["observe", "observe", "aggregate"],
    });
    expect(C02_FEATURE_PROFILE).not.toHaveProperty("aggregate_order");
    expect(C02_FEATURE_PROFILE).not.toHaveProperty("final_response");
    expect(C02_FEATURE_PROFILE).not.toHaveProperty("completed_replay");
  });

  it("steers the normal observe, observe, aggregate progression", () => {
    const run = prepared();
    expect(evaluate(run, graph())).toMatchObject({
      requestId: "run-1",
      eligibleCriterionIds: ["c02-observe-a", "c02-observe-b"],
    });
    expect(evaluate(run, graph(["c02-observe-a"]))).toMatchObject({
      eligibleCriterionIds: ["c02-observe-b"],
    });
    expect(evaluate(run, graph(["c02-observe-a", "c02-observe-b"]))).toMatchObject({
      eligibleCriterionIds: ["c02-aggregate"],
    });
  });

  it("reconstructs restart progress and suppresses redundant observations", () => {
    const run = prepared({ requestId: "run-restarted" });
    const decision = evaluate(run, graph(["c02-observe-a", "c02-observe-b"]), "c02-observe-a");
    expect(decision).toEqual({
      requestId: "run-restarted",
      eligibleCriterionIds: ["c02-aggregate"],
      attempted: {
        kind: "block",
        criterionId: "c02-observe-a",
        reasonCode: "C02_REDUNDANT_ACTION",
      },
    });
  });

  it("fails closed when the current projection lacks an aggregate prerequisite", () => {
    const run = prepared({ requestId: "run-prerequisite-missing" });
    const decision = evaluate(run, graph(["c02-observe-b"]), "c02-aggregate");
    expect(decision).toEqual({
      requestId: "run-prerequisite-missing",
      eligibleCriterionIds: ["c02-observe-a"],
      attempted: {
        kind: "block",
        criterionId: "c02-aggregate",
        reasonCode: "C02_ACTION_NOT_ELIGIBLE",
      },
    });
  });

  it("rejects hostile ordering, unknown criteria, and an unbound request", () => {
    expect(
      evaluate(prepared({ requestId: "run-hostile" }), graph(), "c02-aggregate"),
    ).toMatchObject({ attempted: { kind: "block", reasonCode: "C02_ACTION_NOT_ELIGIBLE" } });
    expect(() => evaluate(prepared({ requestId: "run-hostile" }), graph(), "invented")).toThrow(
      "GOVERNOR_C02_CRITERION_UNKNOWN",
    );
    expect(() => prepared({ requestId: " " })).toThrow("GOVERNOR_C02_RUN_BINDING_REQUIRED");
    expect(() => prepared({ sessionKey: "session\nforged" })).toThrow(
      "GOVERNOR_C02_RUN_BINDING_REQUIRED",
    );
    expect(() =>
      evaluate(prepared(), [
        { ...graph()[0]!, satisfied: undefined },
        ...graph().slice(1),
      ] as never),
    ).toThrow("GOVERNOR_C02_CRITERION_GRAPH_INVALID");
  });

  it("validates exact request-bound path and command mappings", () => {
    const run = prepared({ requestId: "run-bound", sessionKey: "session-bound" });
    expect(run.requestId).toBe("run-bound");
    expect(run.bindings).toHaveLength(3);
    expect(() =>
      prepared({ bindings: [run.bindings[0]!, run.bindings[0]!, run.bindings[2]!] }),
    ).toThrow("GOVERNOR_C02_RUN_BINDINGS_INVALID");
  });

  it("rejects forged, replayed, reordered, and substituted run bindings", () => {
    const original = material();
    const digest = governorC02RunBindingDigest(original);
    expect(() =>
      prepareGovernorC02Run({ ...original, requestId: "run-2", runBindingDigest: digest }),
    ).toThrow("GOVERNOR_C02_RUN_BINDING_DIGEST_MISMATCH");
    expect(() =>
      prepareGovernorC02Run({ ...original, sessionKey: "session-2", runBindingDigest: digest }),
    ).toThrow("GOVERNOR_C02_RUN_BINDING_DIGEST_MISMATCH");
    expect(() => prepareGovernorC02Run({ ...original, runBindingDigest: "f".repeat(64) })).toThrow(
      "GOVERNOR_C02_RUN_BINDING_DIGEST_MISMATCH",
    );
    expect(() => prepared({ hostToolRegistryDigest: "e".repeat(64) })).toThrow(
      "GOVERNOR_C02_TOOL_REGISTRY_DIGEST_MISMATCH",
    );
    expect(() =>
      prepared({ bindings: [original.bindings[1]!, original.bindings[0]!, original.bindings[2]!] }),
    ).toThrow("GOVERNOR_C02_RUN_BINDINGS_INVALID");
    expect(() =>
      prepared({
        bindings: [
          { ...original.bindings[0]!, canonicalTarget: "unregistered://target" },
          original.bindings[1]!,
          original.bindings[2]!,
        ],
      }),
    ).toThrow("GOVERNOR_C02_RUN_BINDINGS_INVALID");
    expect(() =>
      prepared({
        bindings: [
          { ...original.bindings[0]!, implementationId: "substituted-read" },
          original.bindings[1]!,
          original.bindings[2]!,
        ],
      }),
    ).toThrow("GOVERNOR_C02_RUN_BINDINGS_INVALID");
  });

  it("fences projections to the prepared run and deeply freezes decisions", () => {
    const run = prepared();
    expect(() =>
      evaluateGovernorC02Policy({
        run,
        projectionRequestId: "run-2",
        projectionRunBindingDigest: run.runBindingDigest,
        criteria: graph(),
      }),
    ).toThrow("GOVERNOR_C02_PROJECTION_BINDING_MISMATCH");
    const decision = evaluate(run, graph(["c02-observe-a"]), "c02-observe-a");
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.eligibleCriterionIds)).toBe(true);
    expect(Object.isFrozen(decision.attempted)).toBe(true);
    expect(() => {
      (decision.attempted as { kind: string }).kind = "allow";
    }).toThrow();
    const forged = { ...run } as GovernorC02PreparedRun;
    expect(() =>
      evaluateGovernorC02Policy({
        run: forged,
        projectionRequestId: forged.requestId,
        projectionRunBindingDigest: forged.runBindingDigest,
        criteria: graph(),
      }),
    ).toThrow("GOVERNOR_C02_PREPARED_RUN_INVALID");
  });
});
