import { describe, expect, it } from "vitest";
import { waitForSessionsYieldSiblingTools } from "./attempt.sessions-yield.js";

describe("sessions_yield sibling tool settlement", () => {
  it("waits through active sibling tools before allowing the yield abort", async () => {
    const observations = [2, 2, 1, 1];
    let index = 0;

    await expect(
      waitForSessionsYieldSiblingTools({
        countActiveTools: () =>
          observations[Math.min(index++, observations.length - 1)] ?? 1,
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe(true);
    expect(index).toBeGreaterThanOrEqual(4);
  });

  it("fails closed instead of aborting a sibling that does not settle", async () => {
    await expect(
      waitForSessionsYieldSiblingTools({
        countActiveTools: () => 2,
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe(false);
  });

  it("admits a standalone yield after the short same-batch barrier", async () => {
    let observations = 0;

    await expect(
      waitForSessionsYieldSiblingTools({
        countActiveTools: () => {
          observations += 1;
          return 1;
        },
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe(true);
    expect(observations).toBe(2);
  });
});
