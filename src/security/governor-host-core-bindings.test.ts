import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGovernorAgentLoopCoreBindings } from "./governor-host-core-bindings.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "./governor-host-secrets.js";

function bindings() {
  return createGovernorAgentLoopCoreBindings({
    secrets: resolveGovernorSecrets(syntheticGovernorSecretsEnvironment()),
  });
}

describe("governor agent-loop core bindings", () => {
  it("exposes only receipt/evidence admission and closes its capability", () => {
    const core = bindings();
    expect(Object.keys(core).toSorted()).toEqual([
      "close",
      "evidenceInvalidationResolver",
      "receiptResolver",
      "submitEvidenceInvalidation",
      "submitObservedReceipt",
    ]);
    const receiptId = core.submitObservedReceipt({
      scopeKey: "scope-a",
      taskId: "task-a",
      taskVersion: 1,
      objectiveRevision: 1,
      planVersion: 1,
      sourceKind: "tool",
      sourceIdentity: "test-tool",
      payload: { result: "ok" },
      observedAt: 1,
    });
    expect(core.receiptResolver.resolve(receiptId, "scope-a")?.payload).toEqual({ result: "ok" });
    expect(core.receiptResolver.resolve(receiptId, "scope-b")).toBeNull();
    core.close();
    expect(() =>
      core.submitObservedReceipt({
        scopeKey: "scope-a",
        taskId: "task-a",
        taskVersion: 1,
        objectiveRevision: 1,
        planVersion: 1,
        sourceKind: "tool",
        sourceIdentity: "test-tool",
        payload: {},
        observedAt: 2,
      }),
    ).toThrow("GOVERNOR_HOST_CAPABILITY_CLOSED");
  });

  it("does not import a broad host authority surface", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./governor-host-core-bindings.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(
      /governor-host-(?:broker\.js|channel|delivery|owner|approval|physical|memory|task)/u,
    );
    expect(source).not.toContain("GovernorRuntimeAdapter");
  });
});
