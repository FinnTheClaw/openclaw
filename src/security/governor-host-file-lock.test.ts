import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withGovernorHostFileLock } from "./governor-host-file-lock.js";

const moduleUrl = pathToFileURL(path.resolve("src/security/governor-host-file-lock.ts")).href;

function childArguments(script: string): string[] {
  return ["--import", "tsx", "--input-type=module", "--eval", script];
}

function runChild(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArguments(script), {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lock child exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

describe("governor host OS-backed file lock", () => {
  it("releases ownership when a process exits inside the critical section", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-lock-crash-"));
    const lockPath = path.join(root, "authority.lock");
    try {
      const script = `
        import { withGovernorHostFileLock } from ${JSON.stringify(moduleUrl)};
        withGovernorHostFileLock(${JSON.stringify(lockPath)}, () => process.exit(73));
      `;
      const crashed = spawnSync(process.execPath, childArguments(script), {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(crashed.status).toBe(73);
      expect(withGovernorHostFileLock(lockPath, () => "recovered")).toBe("recovered");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores legacy PID files even when they name a live reused PID", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-lock-pid-"));
    const lockPath = path.join(root, "authority.lock");
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      expect(withGovernorHostFileLock(lockPath, () => "not-pid-owned")).toBe("not-pid-owned");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes simultaneous cross-process writers without forking ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-lock-writers-"));
    const lockPath = path.join(root, "authority.lock");
    const outputPath = path.join(root, "effects.log");
    try {
      await Promise.all(
        Array.from({ length: 4 }, (_, index) => {
          const script = `
            import fs from "node:fs";
            import { withGovernorHostFileLock } from ${JSON.stringify(moduleUrl)};
            withGovernorHostFileLock(${JSON.stringify(lockPath)}, () => {
              fs.appendFileSync(${JSON.stringify(outputPath)}, ${JSON.stringify(`${index}\n`)});
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            });
          `;
          return runChild(script);
        }),
      );
      expect(fs.readFileSync(outputPath, "utf8").trim().split("\n").toSorted()).toEqual([
        "0",
        "1",
        "2",
        "3",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
