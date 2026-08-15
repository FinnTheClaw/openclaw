import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGovernorControllerIfEnabled } from "../tasks/governor/controller-bootstrap.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGovernorHostRuntimeIfEnabled } from "./governor-host-bootstrap.js";

const root = path.resolve(import.meta.dirname, "../..");

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("C07 activation and process trust boundary", () => {
  it("removes the same-process private plugin registration authority", () => {
    expect(fs.existsSync(path.join(root, "src/plugins/memory-governor-private.ts"))).toBe(false);
    expect(source("src/plugins/loader.ts")).not.toMatch(
      /governorMemoryFactory|BundledGovernorMemoryRegistrationHost|privateMemoryRegistration/u,
    );
    expect(source("extensions/memory-lancedb/index.ts")).not.toMatch(
      /authorityBindingKey|createGovernorMemoryBackend|privateHost/u,
    );
    expect(source("package.json")).not.toContain("memory-governor-private");
  });

  it("keeps OFF and shadow startup free of a static C07 interlock import", () => {
    const startup = source("src/gateway/server-startup-config.ts");
    expect(startup).not.toMatch(/^import .*behavior-governor-c07-interlock/mu);
    expect(startup).toContain('await import("../config/behavior-governor-c07-interlock.js")');
    const lifecycle = source("src/gateway/behavior-governor-lifecycle.ts");
    expect(lifecycle).not.toMatch(
      /createInertMemoryGovernorBackend|createRegisteredGovernorMemoryBackend/u,
    );
  });

  it("requires a distinct kernel identity and exposes no authority operation over IPC", () => {
    const supervisor = source("src/security/governor-memory-plugin-process.ts");
    const protocol = source("src/security/governor-memory-plugin-process-protocol.ts");
    expect(supervisor).toContain("frame.groups.some");
    expect(source("src/security/governor-memory-plugin-worker.ts")).toMatch(
      /setgroups\(\[pluginGid\]\)[\s\S]*setgid\(pluginGid\)[\s\S]*setuid\(pluginUid\)/u,
    );
    expect(supervisor).toContain("C07_PLUGIN_PROCESS_IDENTITY_NOT_SEPARATE");
    expect(supervisor).toContain("C07_PLUGIN_PROCESS_PRIVILEGE_REQUIRED");
    expect(protocol).not.toMatch(
      /authorityBindingKey|signingKey|ledgerKey|admit|invalidate|retire|recall/u,
    );
  });

  it("rejects direct host and controller memory injection before persistence allocation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c07-lower-interlock-" },
      async (state) => {
        const before = fs.readdirSync(state.stateDir);
        expect(() =>
          createGovernorHostRuntimeIfEnabled({
            enabled: true,
            stateDir: state.stateDir,
            capabilities: [],
            integrations: { memory: {} } as never,
          }),
        ).toThrow("C07_ARCHITECTURE_NOT_READY");
        expect(() =>
          createGovernorControllerIfEnabled({
            enabled: true,
            stateDir: state.stateDir,
            capabilities: [],
            hostBindings: { memoryBackend: {} } as never,
          }),
        ).toThrow("C07_ARCHITECTURE_NOT_READY");
        expect(fs.readdirSync(state.stateDir)).toEqual(before);
      },
    );
  });
});
