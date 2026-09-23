import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisDesktopBrowserSmoke } from "./desktop-browser-smoke.runtime.js";

type Fault = "none" | "warmup" | "inspect" | "run" | "copy" | "screenshot" | "run-and-stop";

describe("round-seven desktop browser lease cleanup", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-lease-round7-"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  async function exercise(fault: Fault, options: { explicit?: boolean; keepLease?: boolean } = {}) {
    const commands: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      const action = command === "rsync" ? "copy" : (args[0] ?? "");
      commands.push(action);
      if (action === "warmup") {
        if (fault === "warmup") throw new Error("warmup failed");
        return { stdout: "ready lease cbx_abc123\n", stderr: "" };
      }
      if (action === "inspect") {
        if (fault === "inspect") throw new Error("inspect failed");
        return {
          stdout: JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_abc123",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshUser: "crabbox",
            state: "active",
          }),
          stderr: "",
        };
      }
      if (action === "run" && (fault === "run" || fault === "run-and-stop")) {
        throw new Error("browser run failed");
      }
      if (action === "copy") {
        if (fault === "copy") throw new Error("artifact copy failed");
        const output = args.at(-1);
        if (!output) throw new Error("missing output path");
        await fs.mkdir(output, { recursive: true });
        if (fault !== "screenshot") {
          await fs.writeFile(path.join(output, "desktop-browser-smoke.png"), "png");
        }
      }
      if (action === "stop" && fault === "run-and-stop") throw new Error("stop failed");
      return { stdout: "", stderr: "" };
    });
    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: { PATH: process.env.PATH },
      keepLease: options.keepLease,
      leaseId: options.explicit ? "cbx_abc123" : undefined,
      outputDir: "out",
      repoRoot,
    });
    const summary = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, "out", "mantis-desktop-browser-smoke-summary.json"),
        "utf8",
      ),
    ) as { error?: string; status: string };
    return { commands, result, summary };
  }

  it("QL01 stops an owned lease after a passing smoke", async () => {
    const x = await exercise("none");
    expect(x.result.status).toBe("pass");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });

  it("QL02 stops an owned lease after inspect failure", async () => {
    const x = await exercise("inspect");
    expect(x.result.status).toBe("fail");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });

  it("QL03 stops an owned lease after browser run failure", async () => {
    const x = await exercise("run");
    expect(x.summary.error).toContain("browser run failed");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });

  it("QL04 stops an owned lease after artifact-copy failure", async () => {
    const x = await exercise("copy");
    expect(x.result.status).toBe("fail");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });

  it("QL05 stops an owned lease after screenshot absence", async () => {
    const x = await exercise("screenshot");
    expect(x.summary.error).toContain("screenshot was not copied");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });

  it("QL06 never stops when warmup fails before allocating a lease", async () => {
    const x = await exercise("warmup");
    expect(x.result.status).toBe("fail");
    expect(x.commands).not.toContain("stop");
  });

  it("QL07 never stops an externally supplied lease after failure", async () => {
    const x = await exercise("inspect", { explicit: true });
    expect(x.result.status).toBe("fail");
    expect(x.commands).not.toContain("stop");
  });

  it("QL08 honors keepLease on an owned failure", async () => {
    const x = await exercise("run", { keepLease: true });
    expect(x.result.status).toBe("fail");
    expect(x.commands).not.toContain("stop");
  });

  it("QL09 honors keepLease on an owned pass", async () => {
    const x = await exercise("none", { keepLease: true });
    expect(x.result.status).toBe("pass");
    expect(x.commands).not.toContain("stop");
  });

  it("QL10 preserves primary failure when cleanup also fails", async () => {
    const x = await exercise("run-and-stop");
    expect(x.result.status).toBe("fail");
    expect(x.summary.error).toContain("browser run failed");
    expect(x.summary.error).toContain("Lease cleanup failed: stop failed");
    expect(x.commands.filter((c) => c === "stop")).toHaveLength(1);
  });
});
