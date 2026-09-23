import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeClawWorkspaceFile } from "./lifecycle-delete-support.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claw-remove-recovery-"));
  roots.push(root);
  return root;
}

async function put(root: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

function digest(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

async function staged(root: string, relative: string): Promise<string[]> {
  const directory = path.join(root, path.dirname(relative));
  const prefix = path.basename(relative) + ".openclaw-claw-remove-";
  return (await fs.readdir(directory)).filter((name) => name.startsWith(prefix));
}

async function remove(
  root: string,
  relative: string,
  contentDigest: string,
  state: "unchanged" | "modified" | "missing" = "unchanged",
  maxBytes = 1024,
) {
  return removeClawWorkspaceFile(
    { workspace: root, path: relative, contentDigest, state },
    maxBytes,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Claw workspace file removal recovery", () => {
  it("R100-01 deletes an unchanged top-level file", async () => {
    const root = await workspace();
    await put(root, "SOUL.md", "original");
    expect((await remove(root, "SOUL.md", digest("original"))).action).toBe("deleted");
    await expect(fs.stat(path.join(root, "SOUL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await staged(root, "SOUL.md")).toEqual([]);
  });

  it("R100-02 deletes an unchanged empty file", async () => {
    const root = await workspace();
    await put(root, "EMPTY.md", "");
    expect((await remove(root, "EMPTY.md", digest(""))).action).toBe("deleted");
    expect(await staged(root, "EMPTY.md")).toEqual([]);
  });

  it("R100-03 deletes an unchanged nested file", async () => {
    const root = await workspace();
    await put(root, "nested/SOUL.md", "nested");
    expect((await remove(root, "nested/SOUL.md", digest("nested"))).action).toBe("deleted");
    expect(await staged(root, "nested/SOUL.md")).toEqual([]);
  });

  it("R100-04 retains an already-marked modified file", async () => {
    const root = await workspace();
    await put(root, "SOUL.md", "user edit");
    expect((await remove(root, "SOUL.md", digest("old"), "modified")).action).toBe(
      "retainedModified",
    );
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("user edit");
  });

  it("R100-05 reports a missing recorded file", async () => {
    const root = await workspace();
    expect((await remove(root, "MISSING.md", digest("old"), "missing")).action).toBe("missing");
  });

  it("R100-06 restores a file when its digest changed before staged deletion", async () => {
    const root = await workspace();
    await put(root, "SOUL.md", "new content");
    expect((await remove(root, "SOUL.md", digest("old content"))).action).toBe("retainedModified");
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("new content");
    expect(await staged(root, "SOUL.md")).toEqual([]);
  });

  it("R100-07 restores a top-level file after staged read exceeds the byte limit", async () => {
    const root = await workspace();
    await put(root, "SOUL.md", "four");
    expect((await remove(root, "SOUL.md", digest("four"), "unchanged", 3)).action).toBe("error");
    expect(await fs.readFile(path.join(root, "SOUL.md"), "utf8")).toBe("four");
    expect(await staged(root, "SOUL.md")).toEqual([]);
  });

  it("R100-08 restores a nested file after staged read exceeds the byte limit", async () => {
    const root = await workspace();
    await put(root, "nested/SOUL.md", "payload");
    expect((await remove(root, "nested/SOUL.md", digest("payload"), "unchanged", 6)).action).toBe(
      "error",
    );
    expect(await fs.readFile(path.join(root, "nested/SOUL.md"), "utf8")).toBe("payload");
    expect(await staged(root, "nested/SOUL.md")).toEqual([]);
  });

  it("R100-09 restores a Unicode-named file after staged read exceeds the limit", async () => {
    const root = await workspace();
    await put(root, "SOUL-雪.md", "payload");
    expect((await remove(root, "SOUL-雪.md", digest("payload"), "unchanged", 6)).action).toBe(
      "error",
    );
    expect(await fs.readFile(path.join(root, "SOUL-雪.md"), "utf8")).toBe("payload");
    expect(await staged(root, "SOUL-雪.md")).toEqual([]);
  });

  it("R100-10 can retry and delete the restored file with a sufficient byte limit", async () => {
    const root = await workspace();
    await put(root, "SOUL.md", "payload");
    expect((await remove(root, "SOUL.md", digest("payload"), "unchanged", 6)).action).toBe("error");
    expect((await remove(root, "SOUL.md", digest("payload"), "unchanged", 7)).action).toBe(
      "deleted",
    );
    expect(await staged(root, "SOUL.md")).toEqual([]);
  });
});
