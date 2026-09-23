import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerWorkspaceResultConflict } from "./workspace-conflicts.js";
import { finalizeWorkspaceResultConflicts } from "./workspace-result-finalize.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await runCommandWithTimeout(
    ["git", "-c", `core.hooksPath=${os.devNull}`, "-C", root, ...args],
    { timeoutMs: 10_000 },
  );
  expect(result.code, result.stderr || result.stdout).toBe(0);
}

async function repository(): Promise<string> {
  const root = path.join(tempDirs.make("worker-conflict-order-"), "repository");
  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await git(
    root,
    "-c",
    "user.name=Workspace Test",
    "-c",
    "user.email=workspace@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
  return root;
}

type Case = {
  id: string;
  prior: boolean;
  next: "new" | "clear" | "same";
  retain?: boolean;
  fail?: "record" | "report";
  unrelated?: boolean;
  oldRemains: boolean;
  reportCount: number;
};

const cases: Case[] = [
  { id: "GW-R4-01-C01", prior: false, next: "new", oldRemains: false, reportCount: 1 },
  { id: "GW-R4-01-C02", prior: true, next: "new", oldRemains: false, reportCount: 1 },
  { id: "GW-R4-01-C03", prior: true, next: "clear", oldRemains: false, reportCount: 1 },
  {
    id: "GW-R4-01-C04",
    prior: true,
    next: "new",
    fail: "report",
    oldRemains: true,
    reportCount: 1,
  },
  {
    id: "GW-R4-01-C05",
    prior: true,
    next: "clear",
    fail: "report",
    oldRemains: true,
    reportCount: 1,
  },
  {
    id: "GW-R4-01-C06",
    prior: true,
    next: "new",
    fail: "record",
    oldRemains: true,
    reportCount: 0,
  },
  {
    id: "GW-R4-01-C07",
    prior: true,
    next: "clear",
    fail: "record",
    oldRemains: true,
    reportCount: 0,
  },
  { id: "GW-R4-01-C08", prior: true, next: "same", oldRemains: true, reportCount: 1 },
  {
    id: "GW-R4-01-C09",
    prior: true,
    next: "clear",
    retain: true,
    oldRemains: true,
    reportCount: 0,
  },
  {
    id: "GW-R4-01-C10",
    prior: true,
    next: "new",
    unrelated: true,
    oldRemains: false,
    reportCount: 1,
  },
];

describe("worker conflict ref durability — ten-case checkpoint pack", () => {
  it.each(cases)("$id", async (input) => {
    const root = await repository();
    const priorRef = workerWorkspaceResultRef("prior");
    const nextRef = input.next === "same" ? priorRef : workerWorkspaceResultRef("next");
    const unrelatedRef = workerWorkspaceResultRef("unrelated");
    if (input.prior) {
      await git(root, "update-ref", priorRef, "HEAD");
    }
    if (input.next === "new") {
      await git(root, "update-ref", nextRef, "HEAD");
    }
    if (input.unrelated) {
      await git(root, "update-ref", unrelatedRef, "HEAD");
    }
    const priorConflict: WorkerWorkspaceResultConflict | undefined = input.prior
      ? { paths: ["prior.txt"], stagedResultRef: priorRef, totalCount: 1 }
      : undefined;
    const writes: Array<WorkerWorkspaceResultConflict | undefined> = [];
    const placements = {
      recordWorkspaceResultConflict: vi.fn(
        (_claim: WorkerSessionTurnClaim, conflict: WorkerWorkspaceResultConflict | undefined) => {
          if (input.fail === "record") {
            throw new Error("controlled record failure");
          }
          writes.push(conflict);
        },
      ),
    } as unknown as Parameters<typeof finalizeWorkspaceResultConflicts>[0]["placements"];
    const report = vi.fn(async () => {
      // This is the critical ordering oracle: any still-durable old transcript
      // must be backed by an inspectable, real Git ref when reporting begins.
      if (input.prior) {
        await expect(
          hasWorkerWorkspaceResultRef({ root, stagedResultRef: priorRef }),
        ).resolves.toBe(true);
      }
      if (input.fail === "report") {
        throw new Error("controlled transcript failure");
      }
    });
    const operation = finalizeWorkspaceResultConflicts({
      placements,
      turnClaim: {} as WorkerSessionTurnClaim,
      conflictPaths: input.next === "clear" ? [] : ["next.txt"],
      priorConflict,
      stagedResultRef: input.next === "clear" ? null : nextRef,
      retainPriorConflict: input.retain,
      report,
      root,
    });
    if (input.fail) {
      await expect(operation).rejects.toThrow("controlled");
    } else {
      const result = await operation;
      expect(result.conflictRetained).toBe(input.next !== "clear");
    }
    expect(report).toHaveBeenCalledTimes(input.reportCount);
    await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: priorRef })).resolves.toBe(
      input.oldRemains,
    );
    if (input.next !== "clear") {
      await expect(hasWorkerWorkspaceResultRef({ root, stagedResultRef: nextRef })).resolves.toBe(
        true,
      );
    }
    if (input.unrelated) {
      await expect(
        hasWorkerWorkspaceResultRef({ root, stagedResultRef: unrelatedRef }),
      ).resolves.toBe(true);
    }
    if (input.fail === "report") {
      expect(writes).toHaveLength(1);
    }
  });
});
