import { describe, expect, it } from "vitest";
import {
  loadDurableFinnRequestIds,
  mergeFreshFinnRequestIds,
} from "./governor-c02-runtime-finn-evidence.js";

const turn = (requestIds: readonly string[], complete = true) => ({
  eventType: "runtime_model_turn_recorded",
  payload: {
    executionGeneration: 1,
    finnRequestIds: requestIds,
    finnRequestIdEvidenceComplete: complete,
  },
});

describe("C02 restart Finn evidence", () => {
  it("merges a fresh post-restart collector without requiring its historical prefix", () => {
    const durable = loadDurableFinnRequestIds(
      [turn(["req_pre_1"]), turn(["req_pre_1", "req_pre_2"])],
      1,
    );
    const first = mergeFreshFinnRequestIds({
      value: ["req_post_1"],
      complete: true,
      freshPrior: [],
      durablePrior: durable,
    });
    const second = mergeFreshFinnRequestIds({
      value: ["req_post_1", "req_post_2"],
      complete: true,
      freshPrior: first.fresh,
      durablePrior: durable,
    });
    expect(second.merged).toEqual(["req_pre_1", "req_pre_2", "req_post_1", "req_post_2"]);
  });

  it.each([
    { name: "incomplete", value: ["req_post_1"], complete: false, prior: [] },
    { name: "gap", value: ["req_post_1", "req_post_2"], complete: true, prior: [] },
    { name: "duplicate", value: ["req_post_1", "req_post_1"], complete: true, prior: [] },
    { name: "malformed", value: ["not-a-request"], complete: true, prior: [] },
    {
      name: "reordered",
      value: ["req_post_2", "req_post_1"],
      complete: true,
      prior: ["req_post_1"],
    },
    { name: "historical replay", value: ["req_pre_1"], complete: true, prior: [] },
  ])("rejects $name callbacks", ({ value, complete, prior }) => {
    expect(() =>
      mergeFreshFinnRequestIds({
        value,
        complete,
        freshPrior: prior,
        durablePrior: ["req_pre_1", "req_pre_2"],
      }),
    ).toThrow("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
  });
});
