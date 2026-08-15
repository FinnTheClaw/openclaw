import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeFunctionalFinnMemory } from "./memory-materializer.js";
import {
  createFunctionalFinnProjectionPathRegistry,
  resolveFunctionalFinnProjectionPaths,
} from "./memory-projection-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function makeWorkspace(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `functional-finn-path-${name}-`));
  roots.push(root);
  return root;
}

describe("Functional Finn projection path ownership", () => {
  it("uses the one builtin-memory-visible per-agent path and rejects shared ownership", async () => {
    const workspace = await makeWorkspace("owner");
    const paths = resolveFunctionalFinnProjectionPaths({
      agentId: "finn",
      workspaceDir: workspace,
    });
    expect(paths.target).toBe(path.join(workspace, "memory", "functional-finn-verified.md"));
    expect(() =>
      createFunctionalFinnProjectionPathRegistry({
        agentIds: ["finn", "other"],
        workspaceForAgent: () => workspace,
        caseInsensitive: true,
      }),
    ).toThrow(/shared by agents/);
  });

  it("migrates the exact legacy projection idempotently without split recall", async () => {
    const workspace = await makeWorkspace("legacy");
    const paths = resolveFunctionalFinnProjectionPaths({
      agentId: "finn",
      workspaceDir: workspace,
    });
    await fs.mkdir(path.dirname(paths.legacyTarget), { recursive: true });
    await fs.writeFile(
      paths.legacyTarget,
      `# Verified memory\n\n- Old fact <!-- functional-finn:${"a".repeat(64)}; observedAt=1; freshnessUntil=2 -->\n`,
      "utf8",
    );
    await materializeFunctionalFinnMemory({
      paths,
      agentId: "finn",
      records: [],
      attemptId: "b".repeat(64),
    });
    await expect(fs.readFile(paths.target, "utf8")).resolves.toContain(paths.ownerHeader);
    await expect(fs.access(paths.legacyTarget)).rejects.toMatchObject({ code: "ENOENT" });

    await materializeFunctionalFinnMemory({
      paths,
      agentId: "finn",
      records: [],
      attemptId: "c".repeat(64),
    });
    await expect(fs.readFile(paths.target, "utf8")).resolves.toContain(paths.ownerHeader);
  });

  it.each(["canonical", "legacy"] as const)(
    "fails closed on ambiguous %s path ownership",
    async (kind) => {
      const workspace = await makeWorkspace(kind);
      const paths = resolveFunctionalFinnProjectionPaths({
        agentId: "finn",
        workspaceDir: workspace,
      });
      const target = kind === "canonical" ? paths.target : paths.legacyTarget;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "user-owned content\n", "utf8");
      await expect(
        materializeFunctionalFinnMemory({
          paths,
          agentId: "finn",
          records: [],
          attemptId: "d".repeat(64),
        }),
      ).rejects.toThrow(/ownership is ambiguous/);
      await expect(fs.readFile(target, "utf8")).resolves.toBe("user-owned content\n");
    },
  );

  it("rejects a symlinked memory directory before projection write", async () => {
    const workspace = await makeWorkspace("symlink");
    const outside = await makeWorkspace("outside");
    await fs.chmod(outside, 0o755);
    await fs.symlink(outside, path.join(workspace, "memory"), "dir");
    const paths = resolveFunctionalFinnProjectionPaths({
      agentId: "finn",
      workspaceDir: workspace,
    });
    await expect(
      materializeFunctionalFinnMemory({
        paths,
        agentId: "finn",
        records: [],
        attemptId: "e".repeat(64),
      }),
    ).rejects.toThrow(/not an owned real directory/);
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.stat(outside)).mode & 0o777).not.toBe(0o700);
  });
});
