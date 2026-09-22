// Bench Model tests cover live model benchmark CLI safety.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-model.ts";

// Keep this helper limited to one CLI error smoke plus the help smoke. Parser
// edge cases stay in-process so this fast unit file avoids repeated cold TSX startup.
function runBenchModel(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/bench-model.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
  });
}

function runBenchModelAsync(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/bench-model.ts", ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stderr, stdout }));
    },
  );
}

describe("scripts/bench-model", () => {
  it("parses benchmark options without importing live credentials", () => {
    expect(testing.parseArgs(["--runs", "2", "--prompt", "ping"])).toMatchObject({
      help: false,
      prompt: "ping",
      runs: 2,
    });
  });

  it("rejects unknown args before checking provider credentials", () => {
    const result = runBenchModel(["--wat"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expect(result.stderr).not.toContain("Missing ANTHROPIC_API_KEY");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("rejects malformed run counts instead of silently using defaults", () => {
    expect(() => testing.parseArgs(["--runs", "1e3"])).toThrow("--runs must be an integer");
  });

  it("rejects short flag values", () => {
    expect(() => testing.parseArgs(["--prompt", "-h"])).toThrow("--prompt requires a value");
    expect(() => testing.parseArgs(["--runs", "-h"])).toThrow("--runs requires a value");
  });

  it("rejects duplicate value flags", () => {
    expect(() => testing.parseArgs(["--runs", "1", "--runs", "2"])).toThrow(
      "--runs was provided more than once",
    );
  });

  it("fails returned provider errors instead of reporting them as latency samples", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "controlled provider rejection" } }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("benchmark control server did not get a TCP address");
    }

    try {
      const result = await runBenchModelAsync(["--runs", "1"], {
        ANTHROPIC_API_KEY: "test-anthropic-key",
        MINIMAX_API_KEY: "test-minimax-key",
        MINIMAX_BASE_URL: `http://127.0.0.1:${address.port}`,
      });

      expect(result.status).toBe(1);
      expect(requests).toBe(1);
      expect(result.stdout).toContain("Runs: 1");
      expect(result.stdout).not.toContain("minimax run 1/1:");
      expect(result.stdout).not.toContain("Summary (ms):");
      expect(result.stderr).toContain("minimax run 1/1 failed (error)");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("prints help without checking provider credentials", () => {
    const result = runBenchModel(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw model latency benchmark");
    expect(result.stderr).toBe("");
  });
});
