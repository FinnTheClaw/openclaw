import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";
let priorPath: string | undefined;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;

function script(name: string, body: string, where: "bin" | "path" = "bin", mode = 0o755) {
  const directory = join(root, where);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

async function ensure(tool: "fd" | "rg") {
  const { ensureTool } = await import("./tools-manager.js");
  return await ensureTool(tool, true);
}

beforeEach(() => {
  priorPath = process.env.PATH;
  priorAgentDir = process.env.OPENCLAW_AGENT_DIR;
  priorOffline = process.env.OPENCLAW_OFFLINE;
  root = mkdtempSync(join(tmpdir(), "openclaw-cached-tool-health-"));
  process.env.PATH = join(root, "path");
  process.env.OPENCLAW_AGENT_DIR = root;
  process.env.OPENCLAW_OFFLINE = "true";
  vi.resetModules();
});

afterEach(() => {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  if (priorAgentDir === undefined) delete process.env.OPENCLAW_AGENT_DIR;
  else process.env.OPENCLAW_AGENT_DIR = priorAgentDir;
  if (priorOffline === undefined) delete process.env.OPENCLAW_OFFLINE;
  else process.env.OPENCLAW_OFFLINE = priorOffline;
  vi.resetModules();
  rmSync(root, { recursive: true, force: true });
});

describe("round-seven cached tool health (ten cases)", () => {
  it("R7-T01 rejects cached fd that exits nonzero", async () => {
    script("fd", "exit 1");
    await expect(ensure("fd")).resolves.toBeUndefined();
  });

  it("R7-T02 rejects cached rg that exits nonzero", async () => {
    script("rg", "exit 1");
    await expect(ensure("rg")).resolves.toBeUndefined();
  });

  it("R7-T03 rejects cached fd without execute permission", async () => {
    script("fd", "exit 0", "bin", 0o600);
    await expect(ensure("fd")).resolves.toBeUndefined();
  });

  it("R7-T04 rejects a directory occupying the cached rg path", async () => {
    mkdirSync(join(root, "bin", "rg"), { recursive: true });
    await expect(ensure("rg")).resolves.toBeUndefined();
  });

  it("R7-T05 reuses a healthy cached fd", async () => {
    const file = script("fd", "exit 0");
    await expect(ensure("fd")).resolves.toBe(file);
  });

  it("R7-T06 reuses a healthy cached rg", async () => {
    const file = script("rg", "exit 0");
    await expect(ensure("rg")).resolves.toBe(file);
  });

  it("R7-T07 falls back from corrupt cached fd to healthy PATH fdfind", async () => {
    script("fd", "exit 1");
    script("fdfind", "exit 0", "path");
    await expect(ensure("fd")).resolves.toBe("fdfind");
  });

  it("R7-T08 falls back from corrupt cached rg to healthy PATH rg", async () => {
    script("rg", "exit 1");
    script("rg", "exit 0", "path");
    await expect(ensure("rg")).resolves.toBe("rg");
  });

  it("R7-T09 rejects cached fd that terminates by signal", async () => {
    script("fd", "kill -TERM $$");
    await expect(ensure("fd")).resolves.toBeUndefined();
  });

  it("R7-T10 accepts a repaired cached fd on a later call", async () => {
    const file = script("fd", "exit 1");
    await expect(ensure("fd")).resolves.toBeUndefined();
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    await expect(ensure("fd")).resolves.toBe(file);
  });
});
