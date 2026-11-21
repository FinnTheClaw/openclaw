import fs from "node:fs/promises";
import path from "node:path";
import * as directoryWalker from "@openclaw/fs-safe/walk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AsyncTempCaseFactory } from "../../security/test-temp-cases.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./workspace-audit.js";

const isWindows = process.platform === "win32";
vi.mock("@openclaw/fs-safe/walk", async (importOriginal) => {
  const actual = await importOriginal<typeof directoryWalker>();
  return { ...actual, walkDirectory: vi.fn(actual.walkDirectory) };
});
const { walkDirectory: actualWalk } =
  await vi.importActual<typeof directoryWalker>("@openclaw/fs-safe/walk");

describe("security audit workspace skill path escape findings", () => {
  const tempCases = new AsyncTempCaseFactory("openclaw-security-audit-workspace-");

  async function writeSkill(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# skill\n");
  }

  async function makeWorkspace(files = ["safe/SKILL.md"]) {
    const workspaceDir = path.join(await tempCases.makeTmpDir("workspace"), "workspace");
    await fs.mkdir(workspaceDir);
    for (const file of files) {
      await writeSkill(path.join(workspaceDir, "skills", file));
    }
    return workspaceDir;
  }

  async function linkDirectory(target: string, link: string) {
    await fs.symlink(target, link, isWindows ? "junction" : "dir");
  }

  async function linkOutsideSkill(workspaceDir: string) {
    const outsidePath = path.resolve(workspaceDir, "..", "outside.md");
    const skillDir = path.join(workspaceDir, "skills", "leak");
    await fs.mkdir(skillDir, { recursive: true });
    await writeSkill(outsidePath);
    await fs.symlink(outsidePath, path.join(skillDir, "SKILL.md"));
    return outsidePath;
  }

  function audit(workspaceDir: string) {
    return collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
    });
  }

  function expectWarning(
    findings: Awaited<ReturnType<typeof collectWorkspaceSkillSymlinkEscapeFindings>>,
    kind: "symlink_escape" | "scan_truncated",
    detail?: string,
  ) {
    expect(findings.find((entry) => entry.checkId === `skills.workspace.${kind}`)).toMatchObject({
      severity: "warn",
      detail: detail === undefined ? expect.any(String) : expect.stringContaining(detail),
    });
  }

  beforeAll(() => tempCases.setup());
  afterAll(() => tempCases.cleanup());
  afterEach(() => vi.restoreAllMocks());

  it("audits nested escapes through a symlinked skills root without revisiting cycles", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace([]));
    const skillsRoot = path.resolve(workspaceDir, "../shared-skills");
    const outsideDir = path.resolve(workspaceDir, "../outside");
    await fs.mkdir(skillsRoot);
    const outsideSkillPath = path.join(outsideDir, "SKILL.md");
    await writeSkill(outsideSkillPath);
    await linkDirectory(skillsRoot, path.join(workspaceDir, "skills"));
    await linkDirectory(outsideDir, path.join(skillsRoot, "leak"));
    await linkDirectory(skillsRoot, path.join(skillsRoot, "cycle"));
    const findings = await audit(workspaceDir);
    expectWarning(findings, "symlink_escape", outsideSkillPath);
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.scan_truncated");
  });

  it("ignores a dangling skills root", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace([]));
    await linkDirectory(
      path.resolve(workspaceDir, "../missing"),
      path.join(workspaceDir, "skills"),
    );
    expect(await audit(workspaceDir)).toEqual([]);
  });

  it.runIf(!isWindows)("audits explicit workspaces despite malformed defaults", async () => {
    const entries = {
      alpha: { default: true, workspace: await makeWorkspace([]) },
      beta: { default: true, workspace: await makeWorkspace([]) },
    };
    const targets = await Promise.all(
      Object.values(entries).map(({ workspace }) => linkOutsideSkill(workspace)),
    );
    const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
      cfg: { agents: { entries } },
    });
    for (const target of targets) {
      expectWarning(findings, "symlink_escape", target);
    }
  });

  it("accepts an in-workspace skill but warns when its realpath becomes unresolvable", async () => {
    const workspaceDir = await makeWorkspace();
    const findings = await audit(workspaceDir);
    expect(findings.map((entry) => entry.checkId)).not.toContain("skills.workspace.symlink_escape");

    // Rejection and timeout both resolve to null; keep workspace-root resolution working.
    vi.spyOn(fs, "realpath").mockImplementation(async (p: unknown): Promise<string> => {
      if (String(p).endsWith("SKILL.md")) {
        throw new Error("simulated realpath timeout");
      }
      return String(p);
    });
    expectWarning(await audit(workspaceDir), "symlink_escape", "realpath timed out");
  });

  it.each([
    ["directory visit cap", "directory", 40_000, true],
    ["file cap", "file", 2_001, true],
    ["exact file cap with excluded directories", "file", 2_000, false],
  ] as const)("reports scan completeness for %s", async (_name, kind, count, truncated) => {
    const workspaceDir = await makeWorkspace(
      ["a", ".hidden", "node_modules"].map((dir) => `${dir}/SKILL.md`),
    );
    vi.mocked(directoryWalker.walkDirectory).mockImplementationOnce(async (root, options) => {
      const scan = await actualWalk(root);
      const ignored = scan.entries.filter(({ name }) => [".hidden", "node_modules"].includes(name));
      const sample = scan.entries.find((entry) => entry.kind === kind && !ignored.includes(entry))!;
      const visit = kind === "directory" ? options?.descend : options?.include;
      for (let index = 0; index < count; index += 1) {
        await visit?.(sample);
      }
      for (const entry of ignored) {
        await options?.descend?.(entry);
      }
      return { ...scan, entries: [] };
    });
    const findings = await audit(workspaceDir);
    expect(findings.some((finding) => finding.checkId === "skills.workspace.scan_truncated")).toBe(
      truncated,
    );
    if (truncated) {
      expectWarning(findings, "scan_truncated", workspaceDir);
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

  it.each(["", "blocked"])("reports unreadable directory %j as incomplete", async (relative) => {
    const workspaceDir = await makeWorkspace([path.join(relative, "SKILL.md")]);
    const unreadableDir = path.join(workspaceDir, "skills", relative);
    const openDirectory = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === unreadableDir) {
        throw Object.assign(new Error("directory unavailable"), { code: "EACCES" });
      }
      return openDirectory(...args);
    });

    expectWarning(await audit(workspaceDir), "scan_truncated");
  });
});
