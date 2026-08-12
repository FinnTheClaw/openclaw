import { describe, expect, it } from "vitest";
import { loadCurrentGovernorEvidence } from "./current-evidence.js";
import { parseGovernorStoredJson } from "./integrity-error.js";
import type { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import type { GovernorStoreQueries } from "./store-queries.js";
import { createGovernorTaskId } from "./types.js";

function serializedFailure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("GOVERNOR_OPERATION_REJECTED");
    return JSON.stringify({
      name: failure.name,
      message: failure.message,
      cause:
        failure.cause instanceof Error
          ? { name: failure.cause.name, message: failure.cause.message }
          : (failure.cause ?? null),
    });
  }
  throw new Error("GOVERNOR_EXPECTED_FAILURE_MISSING");
}

describe("governor V24 opaque error boundary", () => {
  it("never echoes a caller-provided evidence identifier", () => {
    const marker = "caller-evidence-marker-v24";
    const serialized = serializedFailure(() =>
      loadCurrentGovernorEvidence({
        admissions: { verify: () => undefined } as unknown as GovernorEvidenceAdmissionStore,
        queries: {
          loadEvidence: () => null,
          loadTask: () => null,
        } as unknown as GovernorStoreQueries,
        taskId: createGovernorTaskId("opaque-error-fixture"),
        evidenceId: marker,
      }),
    );
    expect(serialized).toContain("GOVERNOR_EVIDENCE_NOT_FOUND");
    expect(serialized).not.toContain(marker);
  });

  it("never echoes malformed payload values or caller-controlled key paths", () => {
    const valueMarker = "synthetic-private-value-marker-v24";
    const pathMarker = "nested.accessToken.syntheticCallerPathV24";
    const serialized = serializedFailure(() =>
      parseGovernorStoredJson(
        `{"${pathMarker}":"${valueMarker}"`,
        "log",
        "GOVERNOR_STORED_RECORD_INVALID",
      ),
    );
    expect(serialized).toContain("GOVERNOR_STORED_RECORD_INVALID");
    expect(serialized).not.toContain(valueMarker);
    expect(serialized).not.toContain(pathMarker);
  });

  it("keeps very large caller markers out of bounded failures", () => {
    const marker = `caller-marker-${"x".repeat(2 ** 20)}`;
    const serialized = serializedFailure(() =>
      parseGovernorStoredJson(
        JSON.stringify({ fixture: marker }),
        "log",
        "GOVERNOR_STORED_RECORD_INVALID",
      ),
    );
    expect(serialized).toBe(
      '{"name":"GovernorIntegrityError","message":"GOVERNOR_STORED_RECORD_INVALID","cause":null}',
    );
  });
});
