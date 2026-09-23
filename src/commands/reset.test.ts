// Reset command tests cover cleanup runtime behavior, workspace state, and reset prompts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  gatewayService,
  listAgentSessionDirs,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  resolveCleanupPlanForRemoval,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

describe("resetCommand", () => {
  const runtime = createCleanupCommandRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
  });

  it.each([
    {
      failure: "inspection fails",
      arrange: () => gatewayService.isLoaded.mockRejectedValue(new Error("inspection failed")),
    },
    {
      failure: "stop fails",
      arrange: () => gatewayService.stop.mockRejectedValue(new Error("stop failed")),
    },
  ])("preserves user data when gateway $failure", async ({ arrange }) => {
    arrange();

    await expect(
      resetCommand(runtime, {
        scope: "full",
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("stops the managed Gateway before loading the destructive cleanup plan", async () => {
    gatewayService.stop.mockImplementation(async () => {
      expect(resolveCleanupPlanForRemoval).not.toHaveBeenCalled();
    });

    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
    });

    expect(resolveCleanupPlanForRemoval).toHaveBeenCalledOnce();
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(false);
  });

  it("does not reopen workspace state after full state removal", async () => {
    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: false,
    });
  });

  it("removes workspace rows when full state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await resetCommand(runtime, {
      scope: "full",
      yes: true,
      nonInteractive: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });

  const runScopedReset = (dryRun = false) =>
    resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun,
    });

  it("ST05-01 removes one enumerated agent session", async () => {
    await runScopedReset();
    expect(removePath).toHaveBeenCalledWith(
      "/tmp/.openclaw/agents/main/sessions",
      runtime,
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("ST05-02 removes multiple enumerated agent sessions", async () => {
    listAgentSessionDirs.mockResolvedValueOnce([
      "/tmp/.openclaw/agents/main/sessions",
      "/tmp/.openclaw/agents/other/sessions",
    ]);
    await runScopedReset();
    expect(removePath).toHaveBeenCalledWith(
      "/tmp/.openclaw/agents/other/sessions",
      runtime,
      expect.anything(),
    );
  });

  it("ST05-03 succeeds with no session directories", async () => {
    listAgentSessionDirs.mockResolvedValueOnce([]);
    await runScopedReset();
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      true,
    );
  });

  it("ST05-04 fails on an enumeration permission error", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("permission denied"));
    await expect(runScopedReset()).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to inspect session directories; reset is incomplete: Error: permission denied",
    );
  });

  it("ST05-05 fails on an enumeration I/O error", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("I/O error"));
    await expect(runScopedReset()).rejects.toMatchObject({ name: "ExitError", code: 1 });
  });

  it("ST05-06 reports partial cleanup after config removal", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("state unavailable"));
    await expect(runScopedReset()).rejects.toMatchObject({ code: 1 });
    expect(removePath).toHaveBeenCalledWith(
      "/tmp/.openclaw/openclaw.json",
      runtime,
      expect.anything(),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("reset is incomplete"));
  });

  it("ST05-07 fails dry-run when enumeration fails", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("denied"));
    await expect(runScopedReset(true)).rejects.toMatchObject({ code: 1 });
  });

  it("ST05-08 does not announce success when one session removal fails", async () => {
    removePath.mockImplementation(async (target: string) => ({
      ok: !target.endsWith("/sessions"),
    }));
    await expect(runScopedReset()).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
  });

  it("ST05-09 includes nested session paths from enumeration", async () => {
    listAgentSessionDirs.mockResolvedValueOnce(["/tmp/.openclaw/agents/nested/name/sessions"]);
    await runScopedReset();
    expect(removePath).toHaveBeenCalledWith(
      "/tmp/.openclaw/agents/nested/name/sessions",
      runtime,
      expect.anything(),
    );
  });

  it("ST05-10 does not claim Next or attempt sessions after failed inspection", async () => {
    listAgentSessionDirs.mockRejectedValueOnce(new Error("denied"));
    await expect(runScopedReset()).rejects.toMatchObject({ code: 1 });
    expect(cleanupCommandLogMessages(runtime).some((message) => message.startsWith("Next:"))).toBe(
      false,
    );
    expect(removePath).not.toHaveBeenCalledWith(
      "/tmp/.openclaw/agents/main/sessions",
      runtime,
      expect.anything(),
    );
  });
});
