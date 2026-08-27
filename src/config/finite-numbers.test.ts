// Verifies non-finite configuration values fail before any persistence path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigPatch, runConfigSet } from "../cli/config-cli.js";
import { parseBatchSource } from "../cli/config-set-input.js";
import { createConfigIO } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const createdDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-finite-"));
  createdDirectories.push(directory);
  return directory;
}

function rejectingRuntime() {
  const error = vi.fn();
  return {
    error,
    runtime: {
      error,
      exit: (code: number) => {
        throw new Error(`exit:${code}`);
      },
    } as unknown as NonNullable<Parameters<typeof runConfigSet>[0]["runtime"]>,
  };
}

function snapshot(pathname: string): ConfigFileSnapshot {
  return {
    path: pathname,
    exists: true,
    raw: "{}\n",
    parsed: {},
    sourceConfig: {},
    resolved: {},
    valid: true,
    runtimeConfig: {},
    config: {},
    hash: "test-hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as ConfigFileSnapshot;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("finite config number guards", () => {
  it.each(["NaN", "Infinity", "-Infinity", "1e999", "{nested:[1e999]}"])(
    "rejects direct config-set input %s before writes",
    async (value) => {
      const { error, runtime } = rejectingRuntime();
      await expect(
        runConfigSet({
          path: "plugins.entries.demo.config.timeout",
          value,
          cliOptions: {},
          runtime,
        }),
      ).rejects.toThrow("exit:1");
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Value must be a finite number"));
    },
  );

  it("rejects non-finite patch and batch input before a config operation", async () => {
    const directory = await makeTempDir();
    const patchPath = path.join(directory, "patch.json5");
    await fs.writeFile(patchPath, "{plugins:{entries:{demo:{config:{timeout:1e999}}}}}", "utf8");
    const { error, runtime } = rejectingRuntime();
    await expect(runConfigPatch({ cliOptions: { file: patchPath }, runtime })).rejects.toThrow(
      "exit:1",
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Value must be a finite number"));
    expect(() =>
      parseBatchSource({ batchJson: '[{"path":"plugins.entries.demo","value":{"timeout":NaN}}]' }),
    ).toThrow("Value must be a finite number");
  });

  it("preserves root bytes and creates no backup for a non-finite direct write", async () => {
    const home = await makeTempDir();
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const original = '{\n  // retain this comment\n  "plugins": {}\n}\n';
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, "utf8");
    const io = createConfigIO({
      configPath,
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => home,
      logger: { warn: () => {}, error: () => {} },
    });
    await expect(
      io.writeConfigFile({ plugins: { entries: { demo: { config: { timeout: Infinity } } } } }),
    ).rejects.toThrow("Value must be a finite number, got Infinity");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
    await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves include and root bytes for non-finite mutation input", async () => {
    const home = await makeTempDir();
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const includePath = path.join(home, ".openclaw", "config", "plugins.json5");
    const rootRaw = '{\n  "plugins": { "$include": "./config/plugins.json5" }\n}\n';
    const includeRaw = '{\n  // retain this comment\n  "entries": {}\n}\n';
    await fs.mkdir(path.dirname(includePath), { recursive: true });
    await fs.writeFile(configPath, rootRaw, "utf8");
    await fs.writeFile(includePath, includeRaw, "utf8");
    await expect(
      replaceConfigFile({
        snapshot: snapshot(configPath),
        writeOptions: {
          expectedConfigPath: configPath,
          includeFileTargetsForWrite: { [includePath]: includePath },
          assertConfigPathForWrite: () => {},
        },
        nextConfig: {
          plugins: { entries: { demo: { config: { timeout: -Infinity } } } },
        } as OpenClawConfig,
      }),
    ).rejects.toThrow("Value must be a finite number, got -Infinity");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
    await expect(fs.readFile(includePath, "utf8")).resolves.toBe(includeRaw);
    await expect(fs.stat(`${includePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves finite values and raw non-JSON strings", async () => {
    expect(
      parseBatchSource({ batchJson: '[{"path":"plugins.entries.demo","value":-1.25e2}]' }),
    ).toEqual([{ path: "plugins.entries.demo", value: -125 }]);
  });
});
