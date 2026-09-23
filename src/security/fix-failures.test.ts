// Regression cases for permission-remediation result reporting.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixSecurityFootguns } from "./fix.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fix-failure-"));
  roots.push(stateDir);
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, "{}\n");
  await fs.chmod(stateDir, 0o755);
  await fs.chmod(configPath, 0o644);
  return {
    stateDir,
    configPath,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      USERNAME: "test-user",
    },
  };
}

describe("security fix permission failures", () => {
  it.each([
    ["POSIX state chmod EACCES", "state", "EACCES", false],
    ["POSIX config chmod EPERM", "config", "EPERM", false],
    ["POSIX state chmod EIO", "state", "EIO", false],
    ["POSIX config ENOENT skip", "config", "ENOENT", true],
  ] as const)("%s", async (_name, target, code, expectedOk) => {
    const args = await fixture();
    const faultPath = target === "state" ? args.stateDir : args.configPath;
    const realChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (file, mode) => {
      if (String(file) === faultPath) {
        throw Object.assign(new Error(`${code} injected`), { code });
      }
      return realChmod(file, mode);
    });
    const result = await fixSecurityFootguns({ ...args, platform: "linux", channelPlugins: [] });
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        kind: "chmod",
        path: faultPath,
        ...(expectedOk ? { skipped: "missing" } : { error: expect.stringContaining(code) }),
      }),
    );
    expect(result.ok).toBe(expectedOk);
  });

  it.each([
    ["Windows ACL EACCES", "EACCES", false],
    ["Windows ACL EPERM", "EPERM", false],
    ["Windows ACL EIO", "EIO", false],
    ["Windows ACL ENOENT skip", "ENOENT", true],
  ] as const)("%s", async (_name, code, expectedOk) => {
    const args = await fixture();
    const exec = vi.fn(async () => {
      throw Object.assign(new Error(`${code} injected`), { code });
    });
    const result = await fixSecurityFootguns({
      ...args,
      platform: "win32",
      exec,
      channelPlugins: [],
    });
    expect(exec).toHaveBeenCalled();
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        kind: "icacls",
        path: args.stateDir,
        ...(expectedOk ? { skipped: "missing" } : { error: expect.stringContaining(code) }),
      }),
    );
    expect(result.ok).toBe(expectedOk);
  });
});
