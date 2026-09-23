// Workspace audit tests cover security audit results for workspace skill folders.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { AsyncTempCaseFactory } from "../../security/test-temp-cases.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./workspace-audit.js";

const isWindows = process.platform === "win32";

describe("security audit workspace skill path escape findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-workspace-");

  function requireFinding(
    findings: Awaited<ReturnType<typeof collectWorkspaceSkillSymlinkEscapeFindings>>,
    checkId: string,
  ) {
    const finding = findings.find((entry) => entry.checkId === checkId);
    if (!finding) {
      throw new Error(`expected security finding ${checkId}`);
    }
    return finding;
  }

  beforeAll(async () => {
    await tempCases.setup();
  });

  afterAll(async () => {
    await tempCases.cleanup();
  });

  it("evaluates workspace skill path escape findings", async () => {
    const runs = [
      !isWindows
        ? (async () => {
            const tmp = await tempCases.makeTmpDir("workspace-skill-symlink-escape");
            const workspaceDir = path.join(tmp, "workspace");
            const outsideDir = path.join(tmp, "outside");
            await fs.mkdir(path.join(workspaceDir, "skills", "leak"), { recursive: true });
            await fs.mkdir(outsideDir, { recursive: true });
            const outsideSkillPath = path.join(outsideDir, "SKILL.md");
            await fs.writeFile(outsideSkillPath, "# outside\n", "utf-8");
            await fs.symlink(
              outsideSkillPath,
              path.join(workspaceDir, "skills", "leak", "SKILL.md"),
            );
            const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
              cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
            });
            const finding = requireFinding(findings, "skills.workspace.symlink_escape");
            expect(finding.severity).toBe("warn");
            expect(finding.detail).toContain(outsideSkillPath);
          })()
        : Promise.resolve(),
      (async () => {
        const tmp = await tempCases.makeTmpDir("workspace-skill-in-root");
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "safe"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, "skills", "safe", "SKILL.md"),
          "# in workspace\n",
          "utf-8",
        );
        const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        });
        expect(findings.map((entry) => entry.checkId)).not.toContain(
          "skills.workspace.symlink_escape",
        );
      })(),
    ];

    await Promise.all(runs);
  });

  it.runIf(!isWindows)(
    "audits every explicit workspace when malformed defaults prevent default resolution",
    async () => {
      const tmp = await tempCases.makeTmpDir("workspace-skill-malformed-roster");
      const workspaceA = path.join(tmp, "workspace-a");
      const workspaceB = path.join(tmp, "workspace-b");
      const outsideA = path.join(tmp, "outside-a.md");
      const outsideB = path.join(tmp, "outside-b.md");
      await fs.writeFile(outsideA, "# outside a\n", "utf-8");
      await fs.writeFile(outsideB, "# outside b\n", "utf-8");
      for (const [workspaceDir, outsidePath] of [
        [workspaceA, outsideA],
        [workspaceB, outsideB],
      ] as const) {
        const skillDir = path.join(workspaceDir, "skills", "leak");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.symlink(outsidePath, path.join(skillDir, "SKILL.md"));
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            alpha: { default: true, workspace: workspaceA },
            beta: { default: true, workspace: workspaceB },
          },
        },
      };

      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({ cfg });
      const detail = findings
        .filter((finding) => finding.checkId === "skills.workspace.symlink_escape")
        .map((finding) => finding.detail)
        .join("\n");
      expect(detail).toContain(outsideA);
      expect(detail).toContain(outsideB);
    },
  );

  it("treats an unresolvable realpath (timeout/error simulation) as a potential symlink escape", async () => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-realpath-unresolvable");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsDir = path.join(workspaceDir, "skills", "suspect-skill");
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "SKILL.md"), "# suspect\n", "utf-8");

    // Simulate realpath failing for the skill file path — this mirrors what
    // happens when a slow/hanging NFS or SMB mount causes the 2 s deadline in
    // realpathWithTimeout to fire. The .catch(() => null) inside the helper
    // converts any rejection to null, which is the same signal produced by a
    // genuine timeout. All other paths resolve to their string value so the BFS
    // and workspace-root detection work normally.
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: unknown): Promise<string> => {
        if (String(p).endsWith("SKILL.md")) {
          throw new Error("simulated realpath timeout");
        }
        return String(p);
      });

    try {
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
      });
      const escapeFinding = requireFinding(findings, "skills.workspace.symlink_escape");
      expect(escapeFinding.severity).toBe("warn");
      // The finding must call out that realpath was unverifiable, not that it
      // resolved to a path outside the workspace.
      expect(escapeFinding.detail).toContain("realpath timed out");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("surfaces scan_truncated finding when BFS visit cap is hit", async () => {
    const tmp = await tempCases.makeTmpDir("workspace-skill-bfs-truncated");
    const workspaceDir = path.join(tmp, "workspace");
    const skillsRoot = path.join(workspaceDir, "skills");
    await fs.mkdir(skillsRoot, { recursive: true });

    // Use a tiny injected visit cap to exercise the truncation branch without
    // forcing the test to await tens of thousands of mocked readdir calls.
    const FAKE_DIRS = 3;
    const fakeDirEntries = Array.from({ length: FAKE_DIRS }, (_, i) => ({
      name: `d${i}`,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: skillsRoot,
      path: skillsRoot,
    })) as unknown as Awaited<ReturnType<typeof fs.readdir>>;

    let readdirCalls = 0;
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async () => {
      return readdirCalls++ === 0 ? fakeDirEntries : ([] as unknown as typeof fakeDirEntries);
    });
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockImplementation(async (p: unknown) => String(p));

    try {
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        skillScanLimits: { maxDirVisits: 2 },
      });
      const truncFinding = requireFinding(findings, "skills.workspace.scan_truncated");
      expect(truncFinding.severity).toBe("warn");
      expect(truncFinding.detail).toContain(workspaceDir);
    } finally {
      readdirSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });
  it.runIf(!isWindows)("SKILL-01 outside root symlink with SKILL.md", async () => {
    const t = await tempCases.makeTmpDir("skill-root-01");
    const w = path.join(t, "workspace"),
      o = path.join(t, "outside");
    await fs.mkdir(w, { recursive: true });
    await fs.mkdir(o);
    await fs.writeFile(path.join(o, "SKILL.md"), "# skill\n", "utf-8");
    await fs.symlink(o, path.join(w, "skills"));
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain(o);
  });
  it.runIf(!isWindows)("SKILL-02 outside root symlink with nested SKILL.md", async () => {
    const t = await tempCases.makeTmpDir("skill-root-02");
    const w = path.join(t, "workspace"),
      o = path.join(t, "outside");
    await fs.mkdir(path.join(o, "nested"), { recursive: true });
    await fs.mkdir(w);
    await fs.writeFile(path.join(o, "nested", "SKILL.md"), "# nested\n", "utf-8");
    await fs.symlink(o, path.join(w, "skills"));
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain(o);
  });
  it.runIf(!isWindows)(
    "SKILL-03 internal root symlink is scanned without false escape",
    async () => {
      const t = await tempCases.makeTmpDir("skill-root-03");
      const w = path.join(t, "workspace"),
        target = path.join(w, "shared-skills");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "SKILL.md"), "# safe\n");
      await fs.symlink(target, path.join(w, "skills"));
      const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      });
      expect(findings.map((x) => x.checkId)).not.toContain("skills.workspace.symlink_escape");
    },
  );
  it("SKILL-04 ordinary root with regular SKILL.md is clean", async () => {
    const t = await tempCases.makeTmpDir("skill-root-04"),
      w = path.join(t, "workspace");
    await fs.mkdir(path.join(w, "skills"), { recursive: true });
    await fs.writeFile(path.join(w, "skills", "SKILL.md"), "# safe\n");
    const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
    });
    expect(findings.map((x) => x.checkId)).not.toContain("skills.workspace.symlink_escape");
  });
  it.runIf(!isWindows)("SKILL-05 nested escaped file symlink remains reported", async () => {
    const t = await tempCases.makeTmpDir("skill-root-05"),
      w = path.join(t, "workspace");
    const o = path.join(t, "outside.md");
    await fs.mkdir(path.join(w, "skills", "nested"), { recursive: true });
    await fs.writeFile(o, "# outside\n");
    await fs.symlink(o, path.join(w, "skills", "nested", "SKILL.md"));
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain(o);
  });
  it.runIf(!isWindows)("SKILL-06 broken root symlink is explicitly unverifiable", async () => {
    const t = await tempCases.makeTmpDir("skill-root-06"),
      w = path.join(t, "workspace");
    await fs.mkdir(w, { recursive: true });
    await fs.symlink(path.join(t, "missing"), path.join(w, "skills"));
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain("unverifiable");
  });
  it("SKILL-07 root realpath timeout is explicitly unverifiable", async () => {
    const t = await tempCases.makeTmpDir("skill-root-07"),
      w = path.join(t, "workspace");
    await fs.mkdir(w, { recursive: true });
    await fs.mkdir(path.join(t, "outside"));
    const root = path.join(w, "skills");
    await fs.symlink(path.join(t, "outside"), root);
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (p: unknown) => {
      if (String(p) === root) throw new Error("simulated timeout");
      return String(p);
    });
    try {
      const f = requireFinding(
        await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
        }),
        "skills.workspace.symlink_escape",
      );
      expect(f.detail).toContain("unverifiable");
    } finally {
      spy.mockRestore();
    }
  });
  it.runIf(!isWindows)("SKILL-08 empty outside root symlink still reports escape", async () => {
    const t = await tempCases.makeTmpDir("skill-root-08");
    const w = path.join(t, "workspace"),
      o = path.join(t, "empty-outside");
    await fs.mkdir(w, { recursive: true });
    await fs.mkdir(o);
    await fs.symlink(o, path.join(w, "skills"));
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({
        cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain(o);
  });
  it.runIf(!isWindows)("SKILL-09 scan cap remains visible for traversed root symlink", async () => {
    const t = await tempCases.makeTmpDir("skill-root-09");
    const w = path.join(t, "workspace"),
      target = path.join(w, "shared-skills");
    await fs.mkdir(path.join(target, "nested"), { recursive: true });
    await fs.symlink(target, path.join(w, "skills"));
    const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: w } } } satisfies OpenClawConfig,
      skillScanLimits: { maxDirVisits: 1 },
    });
    expect(requireFinding(findings, "skills.workspace.scan_truncated").severity).toBe("warn");
  });
  it.runIf(!isWindows)("SKILL-10 isolates the escaped root to the affected workspace", async () => {
    const t = await tempCases.makeTmpDir("skill-root-10");
    const a = path.join(t, "workspace-a"),
      b = path.join(t, "workspace-b"),
      o = path.join(t, "outside");
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(path.join(b, "skills"), { recursive: true });
    await fs.mkdir(o);
    await fs.symlink(o, path.join(a, "skills"));
    await fs.writeFile(path.join(b, "skills", "SKILL.md"), "# safe\n");
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          alpha: { default: true, workspace: a },
          beta: { workspace: b },
        },
      },
    };
    const f = requireFinding(
      await collectWorkspaceSkillSymlinkEscapeFindings({ cfg }),
      "skills.workspace.symlink_escape",
    );
    expect(f.detail).toContain(a);
    expect(f.detail).toContain(o);
    expect(f.detail).not.toContain(b);
  });
});
