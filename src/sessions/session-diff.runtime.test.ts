import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGit, runGitBuffered } from "../agents/worktrees/git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { collectCheckoutDiff, collectCheckoutDiffBaseline } from "./session-diff.runtime.js";

vi.mock("../agents/worktrees/git.js", () => ({
  runGit: vi.fn(),
  runGitBuffered: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

describe("baseline inventory command settlement", () => {
  it.each(["tracked", "untracked"] as const)(
    "joins the other inventory before returning a %s command failure",
    async (failed) => {
      const root = tempDirs.make("openclaw-baseline-inventory-");
      vi.mocked(runGit).mockResolvedValue({
        stdout: `sha1\n${root}\n`,
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
        timeoutMs: 30_000,
      });
      const gates = { tracked: createDeferredCore(), untracked: createDeferredCore() };
      const entered = new Set<string>();
      const failure = new Error(`${failed} inventory failed`);
      vi.mocked(runGitBuffered).mockImplementation(async (_cwd, args) => {
        const kind = args.includes("diff") ? "tracked" : "untracked";
        entered.add(kind);
        await gates[kind].promise;
        if (kind === failed) {
          throw failure;
        }
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: 30_000,
        };
      });
      let settled = false;
      const capture = collectCheckoutDiffBaseline({ cwd: root });
      const observed = capture.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.waitFor(() => expect(entered).toEqual(new Set(["tracked", "untracked"])));
        gates[failed].resolve();
        await nextTurn();
        expect(settled).toBe(false);
        gates[failed === "tracked" ? "untracked" : "tracked"].resolve();
        await expect(capture).rejects.toBe(failure);
      } finally {
        gates.tracked.resolve();
        gates.untracked.resolve();
        await observed;
      }
    },
  );
});

describe("checkout diff required inventory output", () => {
  it.each([
    {
      label: "clipped mid-token tail",
      shape: "mid-token",
      stdoutBytes: 17,
      stderrBytes: 0,
      expected: "error",
    },
    {
      label: "clipped framed tail",
      shape: "framed",
      stdoutBytes: 29,
      stderrBytes: 0,
      expected: "error",
    },
    {
      label: "clipped empty tail",
      shape: "empty",
      stdoutBytes: 1,
      stderrBytes: 0,
      expected: "error",
    },
    {
      label: "complete modified inventory",
      shape: "framed",
      stdoutBytes: 0,
      stderrBytes: 0,
      expected: "modified",
    },
    {
      label: "genuinely empty inventory",
      shape: "empty",
      stdoutBytes: 0,
      stderrBytes: 0,
      expected: "empty",
    },
    {
      label: "stderr-only clipping",
      shape: "framed",
      stdoutBytes: 0,
      stderrBytes: 11,
      expected: "modified",
    },
  ] as const)("does not mistake clipped Git inventory for complete output: $label", async (row) => {
    const root = tempDirs.make("openclaw-checkout-inventory-");
    await fs.writeFile(path.join(root, "tracked.txt"), "after\nextra\n");
    const head = "a".repeat(40);
    const inventory = ":100644 100644 aaaaaaa bbbbbbb M\0tracked.txt\0" + "2\t1\ttracked.txt\0";
    const patch =
      "diff --git a/tracked.txt b/tracked.txt\n" +
      "index aaaaaaa..bbbbbbb 100644\n--- a/tracked.txt\n+++ b/tracked.txt\n" +
      "@@ -1 +1,2 @@\n-before\n+after\n+extra\n";
    const success = {
      code: 0,
      termination: "exit" as const,
      stderr: "",
      stdout: "",
      signal: null,
      killed: false,
      timeoutMs: 30_000,
    };
    const inventoryResult = {
      ...success,
      stdout:
        row.shape === "empty"
          ? ""
          : row.shape === "mid-token"
            ? "pped-name.txt\0" + "7\t2\ttracked.txt\0"
            : inventory,
      stdoutTruncatedBytes: row.stdoutBytes,
      stderrTruncatedBytes: row.stderrBytes,
    };
    const inventoryBefore = structuredClone(inventoryResult);
    const inventoryReceipts: Array<{ cwd: string; args: string[] }> = [];
    vi.mocked(runGit).mockImplementation(async (cwd, args) => {
      if (args.includes("--show-object-format")) {
        return { ...success, stdout: `sha1\n${root}\n${head}\n` };
      }
      if (args.includes("--abbrev-ref")) {
        return { ...success, stdout: "main\n" };
      }
      if (args.includes("--raw")) {
        inventoryReceipts.push({ cwd, args: [...args] });
        return inventoryResult;
      }
      if (args.includes("--patch")) {
        return { ...success, stdout: patch };
      }
      if (args.includes("ls-files")) {
        return success;
      }
      throw new Error(`unexpected fixture Git command: ${args.join(" ")}`);
    });
    const input = { cwd: root, scope: "uncommitted" as const, baseCommit: head };
    const inputBefore = structuredClone(input);
    let result: Awaited<ReturnType<typeof collectCheckoutDiff>> | undefined;
    let failure: unknown;
    await collectCheckoutDiff(input).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = error;
      },
    );

    expect(inventoryReceipts).toEqual([
      {
        cwd: root,
        args: [
          "-c",
          "core.quotePath=false",
          "diff",
          "-M",
          "--raw",
          "--numstat",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "-z",
          head,
          "--",
        ],
      },
    ]);
    if (row.expected === "error") {
      expect(failure).toMatchObject({
        name: "CommandExecutionError",
        message: expect.stringContaining("output limit exceeded"),
      });
      expect(result).toBeUndefined();
    } else {
      expect(failure).toBeUndefined();
      expect(result).toEqual({
        root,
        branch: "main",
        baseRef: head,
        files:
          row.expected === "empty"
            ? []
            : [
                {
                  path: "tracked.txt",
                  status: "modified",
                  additions: 2,
                  deletions: 1,
                  patch,
                },
              ],
        additions: row.expected === "empty" ? 0 : 2,
        deletions: row.expected === "empty" ? 0 : 1,
      });
    }
    expect(runGitBuffered).not.toHaveBeenCalled();
    expect(input).toEqual(inputBefore);
    expect(inventoryResult).toEqual(inventoryBefore);
  });
});
