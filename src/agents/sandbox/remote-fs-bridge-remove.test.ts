import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

async function withBridge(
  run: (
    bridge: ReturnType<typeof createRemoteShellSandboxFsBridge>,
    root: string,
    runtime: RemoteShellSandboxHandle,
  ) => Promise<void>,
) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "remote-remove-"));
  const root = path.join(state, "workspace");
  try {
    await fs.mkdir(root);
    const runtime: RemoteShellSandboxHandle = {
      remoteWorkspaceDir: root,
      remoteAgentWorkspaceDir: root,
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    };
    const bridge = createRemoteShellSandboxFsBridge({
      sandbox: createSandbox({ workspaceDir: root, agentWorkspaceDir: root }),
      runtime,
    });
    await run(bridge, root, runtime);
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
}

describe.runIf(process.platform === "linux")("remote forced removal status", () => {
  it("ST03-01 removes an existing file with force true", async () => {
    await withBridge(async (bridge, root) => {
      await fs.writeFile(path.join(root, "file"), "x");
      await bridge.remove({ filePath: "file", force: true });
      await expect(fs.stat(path.join(root, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ST03-02 removes an existing file with omitted force", async () => {
    await withBridge(async (bridge, root) => {
      await fs.writeFile(path.join(root, "file"), "x");
      await bridge.remove({ filePath: "file" });
      await expect(fs.stat(path.join(root, "file"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ST03-03 recursively removes an existing directory", async () => {
    await withBridge(async (bridge, root) => {
      await fs.mkdir(path.join(root, "tree"));
      await fs.writeFile(path.join(root, "tree", "file"), "x");
      await bridge.remove({ filePath: "tree", recursive: true, force: true });
      await expect(fs.stat(path.join(root, "tree"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ST03-04 tolerates a missing file with force true", async () => {
    await withBridge(async (bridge) => {
      await expect(bridge.remove({ filePath: "missing", force: true })).resolves.toBeUndefined();
    });
  });

  it("ST03-05 tolerates a missing file with omitted force", async () => {
    await withBridge(async (bridge) => {
      await expect(bridge.remove({ filePath: "missing" })).resolves.toBeUndefined();
    });
  });

  it("ST03-06 rejects a missing file with force false", async () => {
    await withBridge(async (bridge) => {
      await expect(bridge.remove({ filePath: "missing", force: false })).rejects.toThrow(
        "not found",
      );
    });
  });

  it.each([
    { name: "ST03-07 propagates denied unlink with force true", force: true },
    { name: "ST03-08 propagates denied unlink with omitted force", force: undefined },
  ])("$name", async ({ force }) => {
    await withBridge(async (bridge, root, runtime) => {
      await fs.writeFile(path.join(root, "file"), "x");
      const original = runtime.runRemoteShellScript.bind(runtime);
      runtime.runRemoteShellScript = async (command) => {
        if (command.args?.[0] === "remove") {
          return { code: 13, stdout: Buffer.alloc(0), stderr: Buffer.from("unlink denied") };
        }
        return original(command);
      };
      await expect(bridge.remove({ filePath: "file", force })).rejects.toThrow("unlink denied");
      await expect(fs.readFile(path.join(root, "file"), "utf8")).resolves.toBe("x");
    });
  });

  it("ST03-09 tolerates a target vanished after existence check with force", async () => {
    await withBridge(async (bridge, root, runtime) => {
      const target = path.join(root, "file");
      await fs.writeFile(target, "x");
      const original = runtime.runRemoteShellScript.bind(runtime);
      runtime.runRemoteShellScript = async (command) => {
        const result = await original(command);
        if (command.script.includes('if [ -e "$1" ]') && command.args?.[0] === target) {
          await fs.rm(target);
        }
        return result;
      };
      await expect(bridge.remove({ filePath: "file", force: true })).resolves.toBeUndefined();
    });
  });

  it("ST03-10 propagates an aborted mutation", async () => {
    await withBridge(async (bridge, root, runtime) => {
      await fs.writeFile(path.join(root, "file"), "x");
      const original = runtime.runRemoteShellScript.bind(runtime);
      runtime.runRemoteShellScript = async (command) => {
        if (command.args?.[0] === "remove") {
          throw new Error("aborted mutation");
        }
        return original(command);
      };
      await expect(bridge.remove({ filePath: "file", force: true })).rejects.toThrow(
        "aborted mutation",
      );
      await expect(fs.readFile(path.join(root, "file"), "utf8")).resolves.toBe("x");
    });
  });
});
