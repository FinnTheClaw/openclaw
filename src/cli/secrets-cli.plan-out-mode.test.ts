// Real-filesystem component coverage for secrets configure --plan-out confidentiality.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecretsCli } from "./secrets-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    configure: vi.fn(),
    apply: vi.fn(),
    confirm: vi.fn(),
    ...createCliRuntimeMock(vi),
  };
});

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (command: Command) => command,
  callGatewayFromCli: vi.fn(),
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, code: number) => runtime.exit(code),
}));
vi.mock("../secrets/configure.js", () => ({
  runSecretsConfigureInteractive: (options: unknown) => mocks.configure(options),
}));
vi.mock("../secrets/apply.js", () => ({
  runSecretsApply: (options: unknown) => mocks.apply(options),
}));
vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => mocks.confirm(options),
}));

type Plan = {
  version: 1;
  protocolVersion: 1;
  generatedAt: string;
  generatedBy: "openclaw secrets configure";
  targets: unknown[];
  providerUpserts?: Record<string, unknown>;
};

const defaultPlan = (): Plan => ({
  version: 1,
  protocolVersion: 1,
  generatedAt: "2026-09-25T00:00:00.000Z",
  generatedBy: "openclaw secrets configure",
  targets: [],
});

function preflight() {
  return {
    mode: "dry-run" as const,
    changed: false,
    changedFiles: [],
    checks: { resolvability: true, resolvabilityComplete: true },
    refsChecked: 0,
    skippedExecRefs: 0,
    warningCount: 0,
    warnings: [],
  };
}

const serialized = (plan: Plan) => `${JSON.stringify(plan, null, 2)}\n`;
const mode = (filename: string) => fs.statSync(filename).mode & 0o7777;
const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-out-mode-"));
  roots.push(root);
  return root;
}

async function runConfigure(filename: string, plan = defaultPlan()): Promise<void> {
  mocks.configure.mockResolvedValue({ plan, preflight: preflight() });
  mocks.confirm.mockResolvedValue(false);
  const program = new Command();
  program.exitOverride();
  registerSecretsCli(program);
  await program.parseAsync(["secrets", "configure", "--plan-out", filename], { from: "user" });
}

async function withUmask<T>(mask: number, run: () => Promise<T>): Promise<T> {
  const prior = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(prior);
  }
}

describe.sequential("secrets configure --plan-out real filesystem", () => {
  beforeEach(() => {
    mocks.configure.mockReset();
    mocks.apply.mockReset();
    mocks.confirm.mockReset();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("CP70-SEC01 creates 0600 under umask 022", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    const plan = defaultPlan();
    await withUmask(0o022, () => runConfigure(filename, plan));
    expect(mode(filename)).toBe(0o600);
    expect(await fsp.readFile(filename, "utf8")).toBe(serialized(plan));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("CP70-SEC02 creates 0600 under permissive umask 000", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    await withUmask(0o000, () => runConfigure(filename));
    expect(mode(filename)).toBe(0o600);
  });

  it("CP70-SEC03 keeps synthetic exec-provider env content private", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    const plan: Plan = {
      ...defaultPlan(),
      providerUpserts: {
        vault: {
          source: "exec",
          command: "/usr/bin/true",
          env: { TEST_TOKEN: "synthetic-marker" },
        },
      },
    };
    await runConfigure(filename, plan);
    expect(mode(filename)).toBe(0o600);
    expect(await fsp.readFile(filename, "utf8")).toBe(serialized(plan));
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("CP70-SEC04 secures a target-only plan", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    const plan: Plan = {
      ...defaultPlan(),
      targets: [
        {
          type: "models.providers.apiKey",
          path: "models.providers.openai.apiKey",
          pathSegments: ["models", "providers", "openai", "apiKey"],
          ref: { source: "env", provider: "default", id: "TEST_TOKEN" },
          providerId: "openai",
        },
      ],
    };
    await runConfigure(filename, plan);
    expect(mode(filename)).toBe(0o600);
    expect(await fsp.readFile(filename, "utf8")).toBe(serialized(plan));
  });

  it("CP70-SEC05 tightens and overwrites an existing 0644 plan", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    await fsp.writeFile(filename, "old plan", { mode: 0o644 });
    await fsp.chmod(filename, 0o644);
    const plan = defaultPlan();
    await runConfigure(filename, plan);
    expect(mode(filename)).toBe(0o600);
    expect(await fsp.readFile(filename, "utf8")).toBe(serialized(plan));
  });

  it("CP70-SEC06 truncates a longer existing private plan without stale tail", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    await fsp.writeFile(filename, "old marker".repeat(1000), { mode: 0o600 });
    const plan = defaultPlan();
    await runConfigure(filename, plan);
    expect(mode(filename)).toBe(0o600);
    expect(await fsp.readFile(filename, "utf8")).toBe(serialized(plan));
  });

  it("CP70-SEC07 follows a final symlink and tightens its target", async () => {
    const root = await testRoot();
    const target = path.join(root, "target.json");
    const link = path.join(root, "plan.json");
    await fsp.writeFile(target, "old plan", { mode: 0o644 });
    await fsp.chmod(target, 0o644);
    await fsp.symlink(target, link);
    const plan = defaultPlan();
    await runConfigure(link, plan);
    expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o600);
    expect(await fsp.readFile(target, "utf8")).toBe(serialized(plan));
  });

  it("CP70-SEC08 leaves a shared-style sticky parent mode unchanged", async () => {
    const root = await testRoot();
    await fsp.chmod(root, 0o1777);
    const filename = path.join(root, "plan.json");
    await runConfigure(filename);
    expect(fs.statSync(root).mode & 0o7777).toBe(0o1777);
    expect(mode(filename)).toBe(0o600);
  });

  it("CP70-SEC09 rejects oversize before touching an existing destination", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    await fsp.writeFile(filename, "sentinel", { mode: 0o644 });
    await fsp.chmod(filename, 0o644);
    const plan: Plan = { ...defaultPlan(), targets: [{ filler: "x".repeat(16 * 1024 * 1024) }] };
    await expect(runConfigure(filename, plan)).rejects.toThrow("__exit__:1");
    expect(await fsp.readFile(filename, "utf8")).toBe("sentinel");
    expect(mode(filename)).toBe(0o644);
    expect(mocks.runtimeLogs).not.toContain(`Plan written to ${filename}`);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("CP70-SEC10 reports an fd write failure without claiming a saved plan", async () => {
    const filename = path.join(await testRoot(), "plan.json");
    await fsp.writeFile(filename, "old", { mode: 0o644 });
    await fsp.chmod(filename, 0o644);
    const original = fs.writeFileSync;
    let planFd: number | undefined;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: unknown,
      ...args: unknown[]
    ) => {
      if (typeof file === "number") {
        planFd = file;
        throw new Error("synthetic plan write failure");
      }
      return Reflect.apply(original, fs, [file, ...args]);
    }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try {
      await expect(runConfigure(filename)).rejects.toThrow("__exit__:1");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(planFd).toBeDefined();
    expect(() => fs.fstatSync(planFd!)).toThrow();
    expect(mode(filename)).toBe(0o600);
    expect(mocks.runtimeLogs).not.toContain(`Plan written to ${filename}`);
    expect(mocks.runtimeErrors.join(" ")).toContain("synthetic plan write failure");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
