import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairWorkspaceMemoryHealth } from "./doctor-workspace.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const fsp = fs.promises;

describe("root memory atomic merge", () => {
  let dir: string;
  let canonical: string;
  let legacy: string;
  let repairParams: Parameters<typeof maybeRepairWorkspaceMemoryHealth>[0];

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-atomic-"));
    canonical = path.join(dir, "MEMORY.md");
    legacy = path.join(dir, "memory.md");
    const prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { yes: true },
    });
    vi.spyOn(prompter, "confirmRuntimeRepair");
    repairParams = {
      cfg: {},
      prompter,
      scope: { agentId: "main", workspaceDir: dir, labelAgent: false },
    };
    note.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function seed(canonicalText = "# Canonical only\n", legacyText = "# Legacy only\n") {
    await fsp.writeFile(canonical, canonicalText);
    await fsp.writeFile(legacy, legacyText);
  }

  async function archivedText() {
    const repairDir = path.join(dir, ".openclaw-repair", "root-memory");
    const archives = await fsp.readdir(repairDir);
    expect(archives).toHaveLength(1);
    return await fsp.readFile(path.join(repairDir, archives[0]!, "memory.md"), "utf8");
  }

  it("CP80-MEM01 merges distinct facts and archives legacy", async () => {
    await seed();
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
    expect(String(note.mock.calls[0]?.[0])).toContain("- merged legacy content from: " + legacy);
    const merged = await fsp.readFile(canonical, "utf8");
    expect(merged).toContain("# Canonical only");
    expect(merged).toContain("# Legacy only");
    expect(await archivedText()).toBe("# Legacy only\n");
    await expect(fsp.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CP80-MEM02 archives identical text without replacing canonical", async () => {
    await seed("# Same\n", "# Same\n");
    const before = await fsp.stat(canonical);
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
    expect(String(note.mock.calls[0]?.[0])).not.toContain("- merged legacy content from:");
    expect(await fsp.readFile(canonical, "utf8")).toBe("# Same\n");
    expect((await fsp.stat(canonical)).ino).toBe(before.ino);
    expect(await archivedText()).toBe("# Same\n");
  });

  it("CP80-MEM03 does nothing when canonical is missing", async () => {
    await fsp.writeFile(legacy, "# Legacy\n");
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(repairParams.prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(await fsp.readFile(legacy, "utf8")).toBe("# Legacy\n");
    await expect(fsp.access(canonical)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CP80-MEM04 does nothing when legacy is missing", async () => {
    await fsp.writeFile(canonical, "# Canonical\n");
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(repairParams.prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(await fsp.readFile(canonical, "utf8")).toBe("# Canonical\n");
    await expect(fsp.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CP80-MEM05 preserves canonical after a partial write failure", async () => {
    await seed();
    let injected = 0;
    const originalWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file) === canonical) {
        injected += 1;
        await originalWriteFile(file, "PARTIAL", "utf8");
        throw new Error("simulated disk full");
      }
      return await originalWriteFile(file, data, options);
    });
    const originalOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file).includes(".MEMORY.md.")) {
        const realWrite = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          injected += 1;
          await realWrite("PARTIAL", "utf8");
          throw new Error("simulated disk full");
        });
      }
      return handle;
    });
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory repair could not be completed:"),
      "Doctor",
    );
    expect(String(note.mock.calls[0]?.[0])).toContain("simulated disk full");
    expect(injected).toBe(1);
    expect(await fsp.readFile(canonical, "utf8")).toBe("# Canonical only\n");
    expect((await fsp.readdir(dir)).filter((name) => name.startsWith(".MEMORY.md."))).toEqual([]);
  });

  it("CP80-MEM06 preserves canonical when publish rename fails", async () => {
    await seed();
    const originalRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(to) === canonical) {
        throw new Error("simulated rename failure");
      }
      return await originalRename(from, to);
    });
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory repair could not be completed:"),
      "Doctor",
    );
    expect(String(note.mock.calls[0]?.[0])).toContain("simulated rename failure");
    expect(await fsp.readFile(canonical, "utf8")).toBe("# Canonical only\n");
    expect((await fsp.readdir(dir)).filter((name) => name.startsWith(".MEMORY.md."))).toEqual([]);
  });

  it("CP80-MEM07 preserves canonical file mode on replacement", async () => {
    await seed();
    await fsp.chmod(canonical, 0o640);
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
    expect((await fsp.stat(canonical)).mode & 0o7777).toBe(0o640);
  });

  it("CP80-MEM08 does not change the workspace directory mode", async () => {
    await seed();
    await fsp.chmod(dir, 0o750);
    const before = (await fsp.stat(dir)).mode & 0o7777;
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
    expect((await fsp.stat(dir)).mode & 0o7777).toBe(before);
  });

  it("CP80-MEM09 leaves full legacy recovery archive after a failed write", async () => {
    await seed();
    const originalOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).includes(".MEMORY.md.")) {
        throw new Error("simulated stage failure");
      }
      return await originalOpen(file, flags, mode);
    });
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory repair could not be completed:"),
      "Doctor",
    );
    expect(String(note.mock.calls[0]?.[0])).toContain("simulated stage failure");
    await expect(fsp.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    const repairDir = path.join(dir, ".openclaw-repair", "root-memory");
    const matches: string[] = [];
    async function findArchived(folder: string): Promise<void> {
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        const item = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          await findArchived(item);
        } else if (entry.name === "memory.md") {
          matches.push(await fsp.readFile(item, "utf8"));
        }
      }
    }
    await findArchived(repairDir);
    expect(matches).toEqual(["# Legacy only\n"]);
  });

  it("CP80-MEM10 leaves unrelated sibling bytes and mode untouched", async () => {
    await seed();
    const sibling = path.join(dir, "notes.txt");
    await fsp.writeFile(sibling, "do not touch\n");
    await fsp.chmod(sibling, 0o604);
    const before = await fsp.stat(sibling);
    await maybeRepairWorkspaceMemoryHealth(repairParams);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Workspace memory root merged:"),
      "Doctor changes",
    );
    expect(await fsp.readFile(sibling, "utf8")).toBe("do not touch\n");
    const after = await fsp.stat(sibling);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.ino).toBe(before.ino);
  });
});
