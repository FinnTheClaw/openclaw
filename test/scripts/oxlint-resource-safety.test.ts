import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as artifactOwnership from "../../scripts/lib/dist-artifact-ownership.mts";
import * as managedChildProcess from "../../scripts/lib/managed-child-process.mts";
import {
  createOxlintShards,
  filterOxlintShards,
  main as runOxlintShards,
} from "../../scripts/run-oxlint-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("the canonical CI scripts selection rejects unsafe test and root-script inventories", () => {
  const root = roots.make("oxlint-resource-lane-");
  const violations = ["test/qa/resource.test.ts", "test/helper.test-support.ts", "entry.mjs"];
  for (const file of [...violations, "test/fixtures/oxlint-boundary-guards/deliberate.ts"]) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'import fs from "node:fs"; fs.readdirSync("root", { recursive: true });');
  }
  writeFileSync(
    path.join(root, "test/safe.ts"),
    'import fs from "node:fs"; fs.readdirSync("root", { recursive: false });',
  );
  // No source paths are passed to the selector: this is the same --only=scripts
  // selection used by CI when hosted jobs own all core and extension stripes.
  const shards = filterOxlintShards(
    createOxlintShards({ cwd: root, env: {}, splitCore: false }),
    new Set(["scripts"]),
  );
  const selected = shards.find((shard) => shard.name === "scripts:resource-safety");
  expect(selected, "CI must own the resource-safety lane").toBeDefined();
  if (!selected) {
    throw new Error("missing resource-safety lane");
  }
  const args = selected.args.filter((arg) => arg !== "--openclaw-focused-config");
  const config = JSON.parse(readFileSync(args[1]!, "utf8"));
  const configPath = path.join(root, args[1]!);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, jsPlugins: [path.resolve("scripts/oxlint-boundary-guards.mjs")] }),
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules/oxlint/bin/oxlint"), ...args, "--format=json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ filename: string; code: string }>;
  };
  expect(
    report.diagnostics.map((diagnostic) => diagnostic.filename.replaceAll("\\", "/")).toSorted(),
  ).toEqual(violations.toSorted());
  expect(
    report.diagnostics.every(
      (diagnostic) => diagnostic.code === "openclaw-boundaries(no-recursive-readdir)",
    ),
  ).toBe(true);
});

it.each([
  { disposition: "ordinary failure", timeout: false, expected: 1 },
  { disposition: "later timeout", timeout: true, expected: 124 },
])(
  "preserves the $disposition across ordered lint shard outcomes",
  async ({ timeout, expected }) => {
    const run = vi
      .spyOn(managedChildProcess, "runManagedCommand")
      .mockRejectedValue(new Error("Unexpected additional fixture shard"))
      .mockResolvedValueOnce(1);
    const ownership = vi
      .spyOn(artifactOwnership, "withDistArtifactOwnership")
      .mockImplementation(async (_root, callback) => callback());
    if (timeout) {
      run.mockRejectedValueOnce(
        Object.assign(new Error("Synthetic shard timeout"), { code: "ETIMEDOUT" }),
      );
    } else {
      run.mockResolvedValueOnce(0);
    }
    try {
      const result = await runOxlintShards(["--only=scripts", "--openclaw-focused-config"], {
        OPENCLAW_OXLINT_SHARD_CONCURRENCY: "1",
        OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
        OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: "0",
      });
      expect(run.mock.calls.map(([options]) => options.args)).toEqual([
        expect.arrayContaining(["config/tsconfig/oxlint.scripts.json"]),
        expect.arrayContaining(["config/oxlint/resource-safety.json"]),
      ]);
      expect(result).toBe(expected);
    } finally {
      ownership.mockRestore();
      run.mockRestore();
    }
  },
);
