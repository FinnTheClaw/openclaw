import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { copyPath, readDirectory } from "./filesystem.js";
import type { OpenClawExecServer } from "./types.js";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "r9-codex-fs-"));
  roots.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(source);
  const execServer = {
    backend: {
      runShellCommand: async (command: { script: string; args: string[] }) => ({
        code: 0,
        stdout: execFileSync("sh", ["-c", command.script, "sh", ...command.args]),
        stderr: Buffer.alloc(0),
      }),
    },
    fsBridge: {
      resolvePath: ({ filePath }: { filePath: string }) => ({ containerPath: filePath }),
      stat: async ({ filePath }: { filePath: string }) => {
        if (!existsSync(filePath)) {
          return null;
        }
        const stat = lstatSync(filePath);
        return {
          type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          size: stat.size,
        };
      },
      mkdirp: async ({ filePath }: { filePath: string }) => {
        mkdirSync(filePath, { recursive: true });
      },
      copyFile: async ({
        sourcePath,
        destinationPath,
      }: {
        sourcePath: string;
        destinationPath: string;
      }) => {
        mkdirSync(join(destinationPath, ".."), { recursive: true });
        copyFileSync(sourcePath, destinationPath);
      },
    },
  } as unknown as OpenClawExecServer;
  const uri = (path: string) => pathToFileURL(path).href;
  const list = async (path = source) =>
    (await readDirectory(execServer, { path: uri(path) })).entries;
  const copy = async () =>
    copyPath(execServer, {
      sourcePath: uri(source),
      destinationPath: uri(target),
      recursive: true,
    });
  return { source, target, list, copy };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("checkpoint R9 Codex filesystem delimiter cases", () => {
  it("R9-CODEX-FS-01 plain file lists with exact name and kind", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "plain.txt"), "plain");
    await expect(f.list()).resolves.toEqual([
      { fileName: "plain.txt", isFile: true, isDirectory: false },
    ]);
  });

  it("R9-CODEX-FS-02 plain nested directory recursively copies content", async () => {
    const f = fixture();
    mkdirSync(join(f.source, "nested"));
    writeFileSync(join(f.source, "nested", "plain.txt"), "nested bytes");
    await f.copy();
    expect(readFileSync(join(f.target, "nested", "plain.txt"), "utf8")).toBe("nested bytes");
  });

  it("R9-CODEX-FS-03 tab-named file lists with its full exact name", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "has\ttab"), "tab");
    await expect(f.list()).resolves.toEqual([
      { fileName: "has\ttab", isFile: true, isDirectory: false },
    ]);
  });

  it("R9-CODEX-FS-04 newline-named file lists with its full exact name", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "has\nnewline"), "newline");
    await expect(f.list()).resolves.toEqual([
      { fileName: "has\nnewline", isFile: true, isDirectory: false },
    ]);
  });

  it("R9-CODEX-FS-05 multiple tabs and newline remain one entry", async () => {
    const f = fixture();
    const name = "a\tb\tc\nend";
    writeFileSync(join(f.source, name), "mixed");
    await expect(f.list()).resolves.toEqual([{ fileName: name, isFile: true, isDirectory: false }]);
  });

  it("R9-CODEX-FS-06 leading and trailing whitespace remains exact", async () => {
    const f = fixture();
    const name = " leading and trailing ";
    writeFileSync(join(f.source, name), "spaces");
    await expect(f.list()).resolves.toEqual([{ fileName: name, isFile: true, isDirectory: false }]);
  });

  it("R9-CODEX-FS-07 nested tab-named file recursively copies exact bytes", async () => {
    const f = fixture();
    mkdirSync(join(f.source, "nested"));
    const name = "tab\tchild";
    const bytes = Buffer.from([0, 1, 2, 255]);
    writeFileSync(join(f.source, "nested", name), bytes);
    await f.copy();
    expect(readFileSync(join(f.target, "nested", name))).toEqual(bytes);
  });

  it("R9-CODEX-FS-08 newline-named directory recursively copies its child", async () => {
    const f = fixture();
    const name = "line\ndir";
    mkdirSync(join(f.source, name));
    writeFileSync(join(f.source, name, "child.txt"), "child");
    await f.copy();
    expect(readFileSync(join(f.target, name, "child.txt"), "utf8")).toBe("child");
  });

  it("R9-CODEX-FS-09 plain and delimiter-bearing siblings copy independently", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "plain"), "one");
    writeFileSync(join(f.source, "plain\tother"), "two");
    await f.copy();
    expect(readdirSync(f.target).sort()).toEqual(["plain", "plain\tother"].sort());
    expect(readFileSync(join(f.target, "plain"), "utf8")).toBe("one");
    expect(readFileSync(join(f.target, "plain\tother"), "utf8")).toBe("two");
  });

  it("R9-CODEX-FS-10 symlink remains unsupported without copying its target", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "outside"), "target");
    symlinkSync(join(f.source, "outside"), join(f.source, "link"));
    await expect(f.copy()).rejects.toThrow("Cannot copy unsupported filesystem entry");
    expect(existsSync(join(f.target, "link"))).toBe(false);
  });
});
