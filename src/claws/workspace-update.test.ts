import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { applyClawWorkspaceUpdate } from "./workspace-update.js";
import { readClawWorkspaceFiles } from "./workspace.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("applyClawWorkspaceUpdate", () => {
  it("F03-01: applies add/change/remove and rolls back with provenance", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-update-");
    const currentRoot = join(root, "current");
    const targetRoot = join(root, "target");
    await mkdir(currentRoot);
    await mkdir(targetRoot);
    await writeFile(join(currentRoot, "SOUL.md"), "current soul\n", "utf8");
    await writeFile(join(currentRoot, "OLD.md"), "old\n", "utf8");
    const targetSoul = Buffer.from("target soul\n");
    await writeFile(
      join(targetRoot, "CLAW.md"),
      Buffer.concat([
        Buffer.from("---\nschemaVersion: 1\nagent: { id: worker }\n---\n"),
        targetSoul,
      ]),
    );
    await writeFile(join(targetRoot, "NEW.md"), "new\n", "utf8");

    const currentParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
        files: [{ source: "OLD.md", path: "OLD.md" }],
      },
    });
    const targetParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        files: [{ source: "NEW.md", path: "NEW.md" }],
      },
    });
    if (!currentParsed.ok || !targetParsed.ok) {
      throw new Error("fixture manifest invalid");
    }
    const currentSource: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: currentRoot,
      manifestPath: join(currentRoot, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:current",
      byteLength: 1,
    };
    const targetSource: ClawSourceIdentity = {
      ...currentSource,
      version: "2.0.0",
      packageRoot: targetRoot,
      manifestPath: join(targetRoot, "CLAW.md"),
      integrity: "sha256:target",
    };
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const currentAddPlan = await buildClawAddPlan({
      manifest: currentParsed.manifest,
      source: currentSource,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(currentAddPlan, {
      env,
      nowMs: 10,
      consentPlanIntegrity: currentAddPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const originalFiles = readClawWorkspaceFiles("worker", { env });
    const updatePlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: targetParsed.manifest,
      targetClawMarkdownBody: targetSoul,
      targetSource,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    const targetAddPlan = await buildClawAddPlan({
      manifest: targetParsed.manifest,
      clawMarkdownBody: targetSoul,
      source: targetSource,
      context: { agentId: "worker", workspace },
    });
    expect(JSON.stringify(updatePlan)).not.toContain("target soul");

    const execution = await applyClawWorkspaceUpdate(updatePlan, targetAddPlan, {
      env,
      nowMs: 20,
    });

    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("target soul\n");
    await expect(readFile(join(workspace, "NEW.md"), "utf8")).resolves.toBe("new\n");
    await expect(access(join(workspace, "OLD.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual([
      expect.objectContaining({ path: "NEW.md", sourcePath: "NEW.md" }),
      expect.objectContaining({ path: "SOUL.md", sourcePath: "CLAW.md" }),
    ]);

    await execution.rollback();

    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("current soul\n");
    await expect(readFile(join(workspace, "OLD.md"), "utf8")).resolves.toBe("old\n");
    await expect(access(join(workspace, "NEW.md"))).rejects.toThrow();
    expect(readClawWorkspaceFiles("worker", { env })).toEqual(originalFiles);

    await rm(join(workspace, "OLD.md"));
    await expect(
      applyClawWorkspaceUpdate(updatePlan, targetAddPlan, { env, nowMs: 30 }),
    ).rejects.toThrow("disappeared after planning");
  });
  type FixtureMode = "add" | "change" | "remove";
  const managedPath = "nested/FILE.md";

  async function makeSingleFileFixture(mode: FixtureMode, extraTargetFile = false) {
    const root = tempDirs.make("openclaw-claw-workspace-rollback-");
    const currentRoot = join(root, "current");
    const targetRoot = join(root, "target");
    await mkdir(currentRoot);
    await mkdir(targetRoot);
    await writeFile(join(currentRoot, "FILE.md"), "before\\n");
    await writeFile(join(targetRoot, "FILE.md"), "after\\n");
    await writeFile(join(targetRoot, "ZZ.md"), "later\\n");
    const fileEntry = { source: "FILE.md", path: managedPath };
    const currentParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: { files: mode === "add" ? [] : [fileEntry] },
    });
    const targetParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker" },
      workspace: {
        files:
          mode === "remove"
            ? []
            : [fileEntry, ...(extraTargetFile ? [{ source: "ZZ.md", path: "nested/ZZ.md" }] : [])],
      },
    });
    if (!currentParsed.ok || !targetParsed.ok) {
      throw new Error("fixture manifest invalid");
    }
    const currentSource: ClawSourceIdentity = {
      kind: "package",
      name: "@acme/worker",
      version: "1.0.0",
      packageRoot: currentRoot,
      manifestPath: join(currentRoot, "openclaw.claw.json"),
      integrityKind: "artifact",
      integrity: "sha256:current",
      byteLength: 1,
    };
    const targetSource: ClawSourceIdentity = {
      ...currentSource,
      version: "2.0.0",
      packageRoot: targetRoot,
      manifestPath: join(targetRoot, "openclaw.claw.json"),
      integrity: "sha256:target",
    };
    const workspace = join(root, "workspace");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const currentAddPlan = await buildClawAddPlan({
      manifest: currentParsed.manifest,
      source: currentSource,
      context: { workspace },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(currentAddPlan, {
      env,
      nowMs: 10,
      consentPlanIntegrity: currentAddPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    await mkdir(join(workspace, "nested"), { recursive: true });
    const originalFiles = readClawWorkspaceFiles("worker", { env });
    const updatePlan = await buildClawUpdatePlan({
      agentId: "worker",
      targetManifest: targetParsed.manifest,
      targetSource,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    const targetAddPlan = await buildClawAddPlan({
      manifest: targetParsed.manifest,
      source: targetSource,
      context: { agentId: "worker", workspace },
    });
    return { workspace, env, updatePlan, targetAddPlan, originalFiles };
  }

  it.each([
    ["F03-02 add", "add"],
    ["F03-03 change", "change"],
  ] as const)(
    "%s: explicit rollback restores prior filesystem and SQLite state",
    async (_id, mode) => {
      const fixture = await makeSingleFileFixture(mode);
      const file = join(fixture.workspace, managedPath);
      const before = mode === "add" ? null : await readFile(file, "utf8");
      const execution = await applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
        env: fixture.env,
        nowMs: 20,
      });
      expect(execution.appliedPaths).toEqual([managedPath]);
      await execution.rollback();
      if (before === null) {
        await expect(access(file)).rejects.toThrow();
      } else {
        await expect(readFile(file, "utf8")).resolves.toBe(before);
      }
      expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual(fixture.originalFiles);
    },
  );

  it("F03-04: later preflight failure rolls back an earlier applied change", async () => {
    const fixture = await makeSingleFileFixture("change", true);
    const file = join(fixture.workspace, managedPath);
    const occupied = join(fixture.workspace, "nested/ZZ.md");
    await writeFile(occupied, "unrelated\\n");
    await expect(
      applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
        env: fixture.env,
        nowMs: 20,
      }),
    ).rejects.toThrow("appeared after planning");
    await expect(readFile(file, "utf8")).resolves.toBe("before\\n");
    await expect(readFile(occupied, "utf8")).resolves.toBe("unrelated\\n");
    expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual(fixture.originalFiles);
  });

  it.each([
    ["F03-05 add", "add"],
    ["F03-06 change", "change"],
    ["F03-07 remove", "remove"],
  ] as const)(
    "%s: pre-effect permission failure is not a false partial rollback",
    async (_id, mode) => {
      const fixture = await makeSingleFileFixture(mode);
      const dir = join(fixture.workspace, "nested");
      const file = join(fixture.workspace, managedPath);
      const before = mode === "add" ? null : await readFile(file, "utf8");
      await chmod(dir, 0o555);
      let caught: unknown;
      try {
        await applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
          env: fixture.env,
          nowMs: 20,
        });
      } catch (error) {
        caught = error;
      } finally {
        await chmod(dir, 0o755);
      }
      // fs-safe may wrap the OS error; verify the actual permission failure in its cause chain.
      let permissionError: unknown = caught;
      let denied = false;
      for (let depth = 0; depth < 4 && permissionError instanceof Error; depth += 1) {
        const code = (permissionError as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          denied = true;
          break;
        }
        permissionError = permissionError.cause;
      }
      // These cases require an unprivileged runtime; privilege bypass is not a pass.
      expect(denied).toBe(true);
      expect(String(caught)).not.toContain("rollback failed");
      if (before === null) {
        await expect(access(file)).rejects.toThrow();
      } else {
        await expect(readFile(file, "utf8")).resolves.toBe(before);
      }
      expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual(fixture.originalFiles);
    },
  );

  it("F03-08: actual SQLite update abort after file write restores previous bytes", async () => {
    const fixture = await makeSingleFileFixture("change");
    const file = join(fixture.workspace, managedPath);
    const database = openOpenClawStateDatabase({ env: fixture.env });
    database.db.exec(
      "CREATE TEMP TRIGGER f03_reject_update BEFORE UPDATE ON main.claw_workspace_files " +
        "BEGIN SELECT RAISE(ABORT, 'f03 update rejected'); END",
    );
    await expect(
      applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
        env: fixture.env,
        nowMs: 20,
      }),
    ).rejects.toThrow("f03 update rejected");
    await expect(readFile(file, "utf8")).resolves.toBe("before\\n");
    expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual(fixture.originalFiles);
  });

  it("F03-09: actual SQLite delete abort after file removal restores previous bytes", async () => {
    const fixture = await makeSingleFileFixture("remove");
    const file = join(fixture.workspace, managedPath);
    const database = openOpenClawStateDatabase({ env: fixture.env });
    database.db.exec(
      "CREATE TEMP TRIGGER f03_reject_delete BEFORE DELETE ON main.claw_workspace_files " +
        "BEGIN SELECT RAISE(ABORT, 'f03 delete rejected'); END",
    );
    await expect(
      applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
        env: fixture.env,
        nowMs: 20,
      }),
    ).rejects.toThrow("f03 delete rejected");
    await expect(readFile(file, "utf8")).resolves.toBe("before\\n");
    expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual(fixture.originalFiles);
  });

  it("F03-10: rollback preserves an unrelated intervening file write", async () => {
    const fixture = await makeSingleFileFixture("change");
    const file = join(fixture.workspace, managedPath);
    const execution = await applyClawWorkspaceUpdate(fixture.updatePlan, fixture.targetAddPlan, {
      env: fixture.env,
      nowMs: 20,
    });
    await writeFile(file, "outside\\n");
    await expect(execution.rollback()).rejects.toMatchObject({ partial: true });
    await expect(readFile(file, "utf8")).resolves.toBe("outside\\n");
    expect(readClawWorkspaceFiles("worker", { env: fixture.env })).toEqual([
      expect.objectContaining({ path: managedPath, contentDigest: expect.any(String) }),
    ]);
  });
});
