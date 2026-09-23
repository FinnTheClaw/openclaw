import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";

const state = vi.hoisted(() => ({
  calls: [] as string[][],
  exists: false,
  running: false,
  hash: "",
  failures: [] as string[],
  registry: null as null | { configHash?: string; lastUsedAtMs?: number },
}));
const registry = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(async () => state.registry),
  removeRegistryEntry: vi.fn(async () => {
    state.registry = null;
  }),
  updateRegistry: vi.fn(async (entry: { configHash?: string }) => {
    state.registry = entry;
  }),
}));
async function spawnEngine([command, ...args]: string[]) {
  state.calls.push(args);
  let code = 0;
  let stdout = "";
  let stderr = "";
  const fail = state.failures.indexOf(args[0] ?? "");
  if (fail >= 0) {
    state.failures.splice(fail, 1);
    code = 1;
    stderr = `injected ${args[0]} failure`;
  } else if (command !== "docker") {
    code = 1;
    stderr = "unexpected engine";
  } else if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
    if (state.exists) stdout = state.running ? "true\n" : "false\n";
    else code = 1;
  } else if (args[0] === "inspect" && args[2]?.includes("openclaw.configHash")) {
    if (state.exists) stdout = `${state.hash}\n`;
    else code = 1;
  } else if (args[0] === "image" && args[1] === "inspect") {
    // Present test image.
  } else if (args[0] === "create") {
    if (state.exists) {
      code = 1;
      stderr = "name already in use";
    } else {
      state.exists = true;
      state.running = false;
      state.hash = args.find((arg) => arg.startsWith("openclaw.configHash="))?.slice(20) ?? "";
    }
  } else if (args[0] === "start") state.running = true;
  else if (args[0] === "exec") {
    /* Setup result is injected above. */
  } else if (args[0] === "rm" && args[1] === "-f") {
    state.exists = false;
    state.running = false;
    state.hash = "";
  } else {
    code = 1;
    stderr = `unexpected action ${args[0]}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}
vi.mock("./registry.js", () => registry);
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnEngine,
}));
let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
let root = "";
beforeAll(async () => {
  vi.resetModules();
  ({ ensureSandboxContainer } = await import("./docker.js"));
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-r7-setup-"));
  Object.assign(state, { exists: false, running: false, hash: "", registry: null });
  state.calls.length = 0;
  state.failures.length = 0;
  registry.readRegistryEntry.mockClear();
  registry.removeRegistryEntry.mockClear();
  registry.updateRegistry.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function config(setupCommand = "printf ready") {
  return {
    scope: "shared",
    workspaceAccess: "rw",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-r7-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: ["ALL"],
      env: {},
      dns: [],
      extraHosts: [],
      binds: [],
      setupCommand,
    },
  } as SandboxConfig;
}
function ensure(cfg: SandboxConfig) {
  return ensureSandboxContainer({
    scopeKey: "shared",
    workspaceDir: root,
    agentWorkspaceDir: root,
    cfg,
  });
}
function count(action: string) {
  return state.calls.filter((args) => args[0] === action).length;
}

describe("round-seven sandbox setup lifecycle (ten cases)", () => {
  it("R7-D01 registers only after successful setup", async () => {
    await expect(ensure(config())).resolves.toBe("oc-r7-shared");
    expect([count("create"), count("start"), count("exec")]).toEqual([1, 1, 1]);
    expect(state.running && Boolean(state.registry)).toBe(true);
  });
  it("R7-D02 removes newly created container after failed setup", async () => {
    state.failures.push("exec");
    await expect(ensure(config())).rejects.toThrow("injected exec failure");
    expect([state.exists, count("rm"), registry.updateRegistry.mock.calls.length]).toEqual([
      false,
      1,
      0,
    ]);
  });
  it("R7-D03 retries on a fresh container after failed setup", async () => {
    state.failures.push("exec");
    await expect(ensure(config())).rejects.toThrow();
    await expect(ensure(config())).resolves.toBe("oc-r7-shared");
    expect([count("create"), count("exec")]).toEqual([2, 2]);
  });
  it("R7-D04 refuses reuse after both setup and owned cleanup fail", async () => {
    state.failures.push("exec", "rm");
    await expect(ensure(config())).rejects.toThrow("could not be removed");
    expect(state.exists).toBe(true);
    await expect(ensure(config())).rejects.toThrow("no completed setup record");
    expect(count("exec")).toBe(1);
    expect(state.registry).toBeNull();
  });
  it("R7-D05 removes newly created container after start failure", async () => {
    state.failures.push("start");
    await expect(ensure(config())).rejects.toThrow("injected start failure");
    expect([count("rm"), count("exec"), state.exists]).toEqual([1, 0, false]);
  });
  it("R7-D06 does not remove existing container on create failure", async () => {
    state.failures.push("create");
    await expect(ensure(config())).rejects.toThrow("injected create failure");
    expect(count("rm")).toBe(0);
  });
  it("R7-D07 accepts empty setup without an exec", async () => {
    await expect(ensure(config("  "))).resolves.toBe("oc-r7-shared");
    expect(count("exec")).toBe(0);
    expect(state.registry).not.toBeNull();
  });
  it("R7-D08 reuses registered same-hash runtime without repeating setup", async () => {
    const cfg = config();
    await ensure(cfg);
    await expect(ensure(cfg)).resolves.toBe("oc-r7-shared");
    expect([count("create"), count("exec")]).toEqual([1, 1]);
  });
  it("R7-D09 recreates cold changed-config runtime and reruns setup", async () => {
    await ensure(config("printf old"));
    state.running = false;
    await expect(ensure(config("printf new"))).resolves.toBe("oc-r7-shared");
    expect([count("rm"), count("create"), count("exec")]).toEqual([1, 2, 2]);
  });
  it("R7-D10 serializes failed and successful concurrent ensures", async () => {
    state.failures.push("exec");
    const results = await Promise.allSettled([ensure(config()), ensure(config())]);
    expect(results.map((value) => value.status)).toEqual(["rejected", "fulfilled"]);
    expect([count("create"), count("exec")]).toEqual([2, 2]);
    expect(state.running && Boolean(state.registry)).toBe(true);
  });
});
