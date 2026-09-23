// Ten-case real child-process pack for the Codex CLI resume process owner.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexCliSessionNodeHostCommands } from "./node-cli-sessions.js";

const command = createCodexCliSessionNodeHostCommands().find(
  (entry) => entry.command === "codex.cli.session.resume",
);
const stub = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.env.OC_TREE_TEST_MODE;
const marker = process.env.OC_TREE_TEST_MARKER;
const outputIndex = process.argv.indexOf("--output-last-message");
const outputPath = process.argv[outputIndex + 1];
process.stdin.resume();
if (mode === "success" || mode === "stdin") {
  let prompt = "";
  process.stdin.on("data", chunk => { prompt += chunk.toString(); });
  process.stdin.on("end", () => {
    fs.writeFileSync(outputPath, mode === "stdin" ? "PROMPT:" + prompt : "completed");
  });
} else if (mode === "exit-error") {
  process.stderr.write("controlled Codex failure");
  process.exitCode = 17;
} else if (mode === "missing-output") {
  process.stdin.on("end", () => {});
} else {
  const writeMarker = "const fs=require('node:fs'); const p=process.argv[1];" +
    (mode === "resistant" ? "process.on('SIGTERM',()=>{});" : "") +
    "setTimeout(()=>fs.writeFileSync(p,'child-survived')," +
    (mode === "resistant" ? "2800" : "500") + ")";
  if (mode === "grandchild") {
    const grand = "const {spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e'," + JSON.stringify(writeMarker) +
      ",process.argv[1]],{stdio:'ignore'});setTimeout(()=>{},10000)";
    spawn(process.execPath, ["-e", grand, marker], { stdio: "ignore" });
  } else {
    spawn(process.execPath, ["-e", writeMarker, marker], {
      stdio: mode === "parent-exits" ? "inherit" : "ignore",
    });
  }
  if (mode !== "parent-exits") {
    setTimeout(() => {}, 10000);
  }
}
`;

let tempDir: string;
let oldPath: string | undefined;
let oldMode: string | undefined;
let oldMarker: string | undefined;

async function invoke(sessionId: string, mode: string, timeoutMs = 120): Promise<string> {
  if (!command) {
    throw new Error("missing production Codex CLI resume command");
  }
  process.env.OC_TREE_TEST_MODE = mode;
  process.env.OC_TREE_TEST_MARKER = path.join(tempDir, `${sessionId}.marker`);
  return await command.handle(
    JSON.stringify({ sessionId, prompt: "test prompt", cwd: tempDir, timeoutMs }),
  );
}
async function markerExists(sessionId: string): Promise<boolean> {
  try {
    await fs.stat(path.join(tempDir, `${sessionId}.marker`));
    return true;
  } catch {
    return false;
  }
}
async function expectNoDelayedMarker(sessionId: string, ms = 650) {
  await delay(ms);
  expect(await markerExists(sessionId)).toBe(false);
}

describe.runIf(process.platform === "linux")(
  "Codex CLI resume owned process tree (ten named cases)",
  () => {
    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-tree-"));
      oldPath = process.env.PATH;
      oldMode = process.env.OC_TREE_TEST_MODE;
      oldMarker = process.env.OC_TREE_TEST_MARKER;
      await fs.writeFile(path.join(tempDir, "codex"), stub, { mode: 0o755 });
      process.env.PATH = `${tempDir}:${oldPath ?? ""}`;
    });

    afterEach(async () => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldMode === undefined) delete process.env.OC_TREE_TEST_MODE;
      else process.env.OC_TREE_TEST_MODE = oldMode;
      if (oldMarker === undefined) delete process.env.OC_TREE_TEST_MARKER;
      else process.env.OC_TREE_TEST_MARKER = oldMarker;
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("C01 timeout removes direct child delayed mutation", async () => {
      await expect(invoke("c01", "child")).rejects.toThrow(/timed out/);
      await expectNoDelayedMarker("c01");
    });

    it("C02 timeout removes grandchild delayed mutation", async () => {
      await expect(invoke("c02", "grandchild")).rejects.toThrow(/timed out/);
      await expectNoDelayedMarker("c02");
    });

    it("C03 resistant child is removed by bounded owned-group fallback", async () => {
      await expect(invoke("c03", "resistant")).rejects.toThrow(/timed out/);
      await expectNoDelayedMarker("c03", 3000);
    }, 12_000);

    it("C04 parent exit with inherited pipes still reaps child", async () => {
      await expect(invoke("c04", "parent-exits")).rejects.toThrow(/timed out/);
      await expectNoDelayedMarker("c04");
    });

    it("C05 normal success retains final-message contract", async () => {
      const raw = await invoke("c05", "success");
      expect(JSON.parse(raw)).toMatchObject({ ok: true, sessionId: "c05", text: "completed" });
    });

    it("C06 immediate nonzero exit reports diagnostic", async () => {
      await expect(invoke("c06", "exit-error")).rejects.toThrow("controlled Codex failure");
    });

    it("C07 timeout does not signal an unrelated detached process", async () => {
      const unrelated = path.join(tempDir, "unrelated.marker");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'alive'),400)",
          unrelated,
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      await expect(invoke("c07", "child")).rejects.toThrow(/timed out/);
      await expectNoDelayedMarker("c07");
      expect(await fs.readFile(unrelated, "utf8")).toBe("alive");
    });

    it("C08 same session can resume after timeout cleanup", async () => {
      await expect(invoke("c08", "child")).rejects.toThrow(/timed out/);
      const raw = await invoke("c08", "success");
      expect(JSON.parse(raw)).toMatchObject({ ok: true, sessionId: "c08", text: "completed" });
      await expectNoDelayedMarker("c08");
    });

    it("C09 successful stub receives exact prompt on stdin", async () => {
      const raw = await invoke("c09", "stdin");
      expect(JSON.parse(raw)).toMatchObject({
        ok: true,
        sessionId: "c09",
        text: "PROMPT:test prompt",
      });
    });

    it("C10 missing final output reports a read error without false success", async () => {
      await expect(invoke("c10", "missing-output")).rejects.toThrow();
      expect(await markerExists("c10")).toBe(false);
    });
  },
);
