import { describe, expect, it, vi } from "vitest";
import { resolveSessionsYieldPendingDescendantError } from "../../tools/sessions-yield-tool.js";
import {
  validateSessionsYieldPendingDescendants,
  waitForSessionsYieldSiblingTools,
} from "./attempt.sessions-yield.js";

describe("sessions_yield sibling tool settlement", () => {
  it("waits through active sibling tools before allowing the yield abort", async () => {
    const observations = [2, 2, 1, 1];
    let index = 0;

    await expect(
      waitForSessionsYieldSiblingTools({
        countActiveTools: () => observations[Math.min(index++, observations.length - 1)] ?? 1,
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

  it("rejects a leaf yield after same-batch tools settle", async () => {
    const observations = [2, 1, 1];
    let index = 0;

    await expect(
      validateSessionsYieldPendingDescendants({
        countActiveTools: () => observations[Math.min(index++, observations.length - 1)] ?? 1,
        countPendingDescendants: () => 0,
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toContain("no descendant work");
  });

  it("admits an orchestrator yield while a descendant remains pending", async () => {
    await expect(
      validateSessionsYieldPendingDescendants({
        countActiveTools: () => 1,
        countPendingDescendants: () => 1,
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeNull();
  });

  it("rejects before inspecting descendants when sibling tools remain active", async () => {
    const countPendingDescendants = vi.fn(() => 1);

    await expect(
      validateSessionsYieldPendingDescendants({
        countActiveTools: () => 2,
        countPendingDescendants,
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).resolves.toContain("sibling tool calls are still active");
    expect(countPendingDescendants).not.toHaveBeenCalled();
  });

  it("fails the final synchronous recheck when the last descendant just settled", () => {
    expect(resolveSessionsYieldPendingDescendantError(1)).toBeNull();
    expect(resolveSessionsYieldPendingDescendantError(0)).toContain("no descendant work");
  });
});
