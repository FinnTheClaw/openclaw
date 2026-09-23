import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSandboxChild, type SandboxChildOwner } from "./sandbox-child.js";

let root = "";
let owners: Set<SandboxChildOwner>;
let statuses: string[];
let errors: unknown[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-r7-child-"));
  owners = new Set();
  statuses = [];
  errors = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function missing() {
  return join(root, "missing");
}
function node(source: string) {
  return [process.execPath, "-e", source];
}
function start(
  argv: string[],
  finalize = async ({ status }: { status: string }) => {
    statuses.push(status);
  },
) {
  return spawnSandboxChild({
    argv,
    env: { PATH: process.env.PATH },
    owners,
    finalizeExec: finalize,
    finalizeStatus: (outcome) => (outcome.exitCode === 0 ? "completed" : "failed"),
    onFinalizeError: (error) => {
      errors.push(error);
    },
  });
}

describe("round-seven sandbox child spawn ownership (ten cases)", () => {
  it("R7-S01 rejects async ENOENT and finalizes failed", async () => {
    await expect(start([missing()])).rejects.toMatchObject({ code: "ENOENT" });
    expect(statuses).toEqual(["failed"]);
    expect(owners.size).toBe(0);
  });
  it("R7-S02 rejects async EACCES and finalizes failed", async () => {
    const file = join(root, "non-executable");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o600);
    await expect(start([file])).rejects.toMatchObject({ code: "EACCES" });
    expect(statuses).toEqual(["failed"]);
  });
  it("R7-S03 rejects empty argv and finalizes failed", async () => {
    await expect(start([])).rejects.toThrow("did not provide a command");
    expect(statuses).toEqual(["failed"]);
  });
  it("R7-S04 settles a healthy child and releases its owner", async () => {
    const child = await start(node("process.exit(0)"));
    await expect(child.settled).resolves.toMatchObject({ exitCode: 0 });
    expect(statuses).toEqual(["completed"]);
    expect(owners.size).toBe(0);
  });
  it("R7-S05 finalizes nonzero exit as failed", async () => {
    const child = await start(node("process.exit(7)"));
    await expect(child.settled).resolves.toMatchObject({ exitCode: 7 });
    expect(statuses).toEqual(["failed"]);
  });
  it("R7-S06 retains stdout from the spawned child", async () => {
    const child = await start(node("process.stdout.write('sandbox-output')"));
    const chunks: Buffer[] = [];
    child.process.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    await child.settled;
    expect(Buffer.concat(chunks).toString("utf8")).toBe("sandbox-output");
    expect(statuses).toEqual(["completed"]);
  });
  it("R7-S07 preserves spawn error when finalization rejects", async () => {
    const finalize = vi.fn(async () => {
      throw new Error("finalize unavailable");
    });
    await expect(start([missing()], finalize)).rejects.toMatchObject({ code: "ENOENT" });
    expect(finalize).toHaveBeenCalledOnce();
    expect(errors.map(String)).toContain("Error: finalize unavailable");
  });
  it("R7-S08 isolates concurrent failed and healthy spawns", async () => {
    const results = await Promise.allSettled([start([missing()]), start(node("process.exit(0)"))]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    const healthy = results[1];
    if (healthy.status !== "fulfilled") throw new Error("healthy spawn failed");
    await healthy.value.settled;
    expect(statuses.toSorted()).toEqual(["completed", "failed"]);
    expect(owners.size).toBe(0);
  });
  it("R7-S09 joins an already settled child without duplicate finalize", async () => {
    const child = await start(node("process.exit(0)"));
    await child.settled;
    await expect(child.terminate()).resolves.toMatchObject({ exitCode: 0 });
    expect(statuses).toEqual(["completed"]);
  });
  it("R7-S10 later process error forces failed finalization", async () => {
    const child = await start(node("setTimeout(() => process.exit(0), 80)"));
    child.process.emit("error", new Error("late transport failure"));
    await child.settled;
    expect(errors.map(String)).toContain("Error: late transport failure");
    expect(statuses).toEqual(["failed"]);
    expect(owners.size).toBe(0);
  });
});
