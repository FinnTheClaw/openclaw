import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  resolveEntrypoint: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));

vi.mock("../../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: mocks.resolveEntrypoint,
}));

vi.mock("../../process/exec.js", () => ({
  runExec: mocks.runExec,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveNodeRunner: vi.fn(() => "/usr/bin/node"),
}));

import { defaultRuntime } from "../../runtime.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";

const pluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: true,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};

const validConfigSnapshot = {
  valid: true as const,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

describe("post-plugin update readiness", () => {
  beforeEach(() => {
    mocks.readConfig.mockReset().mockResolvedValue(validConfigSnapshot);
    mocks.resolveEntrypoint.mockReset().mockResolvedValue("/opt/openclaw/dist/index.js");
    mocks.runExec.mockReset().mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--lint")
        ? `${JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] })}\n`
        : "",
      stderr: "",
    }));
  });

  it("runs declared readiness checks in the updated process before accepting restart", async () => {
    await completePostCorePluginUpdate({
      root: "/opt/openclaw",
      pluginUpdate,
      freshDoctorRequired: true,
      yes: true,
      json: true,
      timeoutMs: 5_000,
    });

    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      [
        "/opt/openclaw/dist/index.js",
        "doctor",
        "--repair",
        "--non-interactive",
        "--no-workspace-suggestions",
        "--yes",
      ],
      ["/opt/openclaw/dist/index.js", "config", "validate", "--json"],
      ["/opt/openclaw/dist/index.js", "doctor", "--lint", "--json", "--severity-min", "error"],
    ]);
    expect(mocks.runExec.mock.calls[2]?.[2]).toMatchObject({
      env: { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
    });
  });

  it("runs updated readiness checks even when no plugin package changed", async () => {
    await completePostCorePluginUpdate({
      root: "/opt/openclaw",
      pluginUpdate: { ...pluginUpdate, changed: false },
      freshDoctorRequired: false,
      yes: true,
      json: true,
      timeoutMs: 5_000,
    });

    expect(mocks.runExec.mock.calls.map(([, args]) => args)).toEqual([
      ["/opt/openclaw/dist/index.js", "doctor", "--lint", "--json", "--severity-min", "error"],
    ]);
  });

  it("returns the owner-provided remediation and refuses restart when readiness fails", async () => {
    mocks.runExec.mockImplementation(async (_command, args: string[]) => {
      if (args.includes("--lint")) {
        throw Object.assign(new Error("readiness failed"), {
          exitCode: 1,
          stdout: `${JSON.stringify({
            ok: false,
            checksRun: 1,
            checksSkipped: 0,
            findings: [
              {
                checkId: "memory-core/managed-local-embedding-setup",
                severity: "error",
                source: "memory-core",
                message: "Managed local embeddings are unavailable.",
                fixHint:
                  "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
              },
            ],
          })}\n`,
          stderr: "",
        });
      }
      return { stdout: "", stderr: "" };
    });

    const result = await completePostCorePluginUpdate({
      root: "/opt/openclaw",
      pluginUpdate,
      freshDoctorRequired: true,
      yes: true,
      json: true,
      timeoutMs: 5_000,
    });

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-failed",
      warnings: [
        {
          pluginId: "memory-core",
          reason: "memory-core/managed-local-embedding-setup",
          message: "Managed local embeddings are unavailable.",
          guidance: [
            "Run `openclaw models --agent main auth login --provider llama-cpp --method local`.",
          ],
        },
      ],
    });
  });

  it.each([
    {
      label: "malformed output",
      stdout: "{not-json\n",
    },
    {
      label: "no declared check",
      stdout: `${JSON.stringify({ ok: true, checksRun: 0, checksSkipped: 0, findings: [] })}\n`,
    },
  ])("fails closed on $label from the updated readiness child", async ({ stdout }) => {
    mocks.runExec.mockImplementation(async (_command, args: string[]) => ({
      stdout: args.includes("--lint") ? stdout : "",
      stderr: "",
    }));

    const result = await completePostCorePluginUpdate({
      root: "/opt/openclaw",
      pluginUpdate,
      freshDoctorRequired: true,
      yes: true,
      json: true,
      timeoutMs: 5_000,
    });

    expect(result.pluginUpdate).toMatchObject({
      status: "error",
      reason: "post-plugin-update-readiness-execution-failed",
      warnings: [
        expect.objectContaining({
          message: "Updated plugin readiness checks could not be completed before restart.",
        }),
      ],
    });
  });
});

describe("fresh Doctor child-output redaction", () => {
  const privateText = "alice@example.test";
  const cases = [
    {
      name: "successful stdout uses the human log sink",
      fails: false,
      json: false,
      stdout: true,
      stderr: false,
      logs: 1,
      errors: 0,
    },
    {
      name: "successful stdout uses the JSON error sink",
      fails: false,
      json: true,
      stdout: true,
      stderr: false,
      logs: 0,
      errors: 1,
    },
    {
      name: "successful stderr uses the human error sink",
      fails: false,
      json: false,
      stdout: false,
      stderr: true,
      logs: 0,
      errors: 1,
    },
    {
      name: "successful stderr uses the JSON error sink",
      fails: false,
      json: true,
      stdout: false,
      stderr: true,
      logs: 0,
      errors: 1,
    },
    {
      name: "failed stdout uses the human log sink",
      fails: true,
      json: false,
      stdout: true,
      stderr: false,
      logs: 1,
      errors: 0,
    },
    {
      name: "failed stdout uses the JSON error sink",
      fails: true,
      json: true,
      stdout: true,
      stderr: false,
      logs: 0,
      errors: 1,
    },
    {
      name: "failed stderr uses the human error sink",
      fails: true,
      json: false,
      stdout: false,
      stderr: true,
      logs: 0,
      errors: 1,
    },
    {
      name: "failed stderr uses the JSON error sink",
      fails: true,
      json: true,
      stdout: false,
      stderr: true,
      logs: 0,
      errors: 1,
    },
    {
      name: "successful dual streams remain separate",
      fails: false,
      json: false,
      stdout: true,
      stderr: true,
      logs: 1,
      errors: 1,
    },
    {
      name: "failed dual streams retain JSON routing and redacted error",
      fails: true,
      json: true,
      stdout: true,
      stderr: true,
      logs: 0,
      errors: 2,
    },
  ] as const;

  beforeEach(() => {
    mocks.runExec.mockReset();
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
  });

  it.each(cases)("$name", async ({ fails, json, stdout, stderr, logs, errors }) => {
    const output = {
      stdout: stdout ? `stdout marker ${privateText}\n` : "",
      stderr: stderr ? `stderr marker ${privateText}\n` : "",
    };
    if (fails) {
      mocks.runExec.mockRejectedValue(Object.assign(new Error("Doctor exited"), output));
    } else {
      mocks.runExec.mockResolvedValue(output);
    }
    const run = runUpdateFinalizationDoctorInFreshProcess({
      phase: "pre-plugin",
      root: "/opt/openclaw",
      entryPath: "/opt/openclaw/dist/index.js",
      nodeRunner: "/usr/bin/node",
      yes: true,
      json,
      timeoutMs: 5_000,
    });
    if (fails) {
      await expect(run).rejects.toThrow("Updated pre-plugin Doctor failed");
      await expect(run).rejects.not.toThrow(privateText);
    } else {
      await expect(run).resolves.toBeUndefined();
    }
    expect(defaultRuntime.log).toHaveBeenCalledTimes(logs);
    expect(defaultRuntime.error).toHaveBeenCalledTimes(errors);
    const logged = [
      ...vi.mocked(defaultRuntime.log).mock.calls,
      ...vi.mocked(defaultRuntime.error).mock.calls,
    ]
      .flat()
      .join("\n");
    expect(logged).not.toContain(privateText);
    if (stdout) {
      expect(logged).toContain("stdout marker");
    }
    if (stderr) {
      expect(logged).toContain("stderr marker");
    }
  });
});
