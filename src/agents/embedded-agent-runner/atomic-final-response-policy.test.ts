import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  installAtomicFinalResponsePolicy,
  resolveAtomicFinalResponsePolicy,
} from "./atomic-final-response-policy.js";

let close: (() => void) | undefined;

afterEach(() => {
  close?.();
  close = undefined;
});

function activate(mode: "shadow" | "enforce" = "enforce"): void {
  ({ close } = installAtomicFinalResponsePolicy(mode));
}

describe("atomic final-response policy", () => {
  it("suppresses high reasoning and continuation retries for a direct denied-tools turn", () => {
    activate();
    expect(
      resolveAtomicFinalResponsePolicy({
        trigger: "user",
        clientToolCount: 0,
        config: { tools: { deny: ["*"] } },
        resolvedThinkLevel: "high",
      }),
    ).toEqual({ thinkLevel: "off", continuationRetryLimit: 0, requireVisibleFinal: true });
  });

  it.each(["off", "minimal", "low", "medium", "adaptive"] as const)(
    "preserves an already bounded %s thinking level",
    (resolvedThinkLevel) => {
      activate();
      expect(
        resolveAtomicFinalResponsePolicy({
          trigger: "manual",
          disableTools: true,
          clientToolCount: 0,
          resolvedThinkLevel,
        })?.thinkLevel,
      ).toBe(resolvedThinkLevel);
    },
  );

  it.each([
    ["shadow", { trigger: "user", disableTools: true, clientToolCount: 0 }],
    ["tool-enabled", { trigger: "user", clientToolCount: 0 }],
    ["client-tool", { trigger: "user", disableTools: true, clientToolCount: 1 }],
    ["child", { trigger: "user", spawnedBy: "parent", disableTools: true, clientToolCount: 0 }],
    ["cron", { trigger: "cron", disableTools: true, clientToolCount: 0 }],
    ["silent", { trigger: "user", disableTools: true, clientToolCount: 0, silentExpected: true }],
  ] as const)("is inert for %s turns", (kind, input) => {
    activate(kind === "shadow" ? "shadow" : "enforce");
    expect(
      resolveAtomicFinalResponsePolicy({ ...input, resolvedThinkLevel: "high" }),
    ).toBeUndefined();
  });

  it("does not override a turn owned by the planned legacy governor", () => {
    activate();
    const config = {
      experimental: { behaviorGovernor: { enabled: true } },
    } as unknown as OpenClawConfig;
    expect(
      resolveAtomicFinalResponsePolicy({
        trigger: "user",
        disableTools: true,
        clientToolCount: 0,
        config,
        resolvedThinkLevel: "high",
      }),
    ).toBeUndefined();
  });

  it("does not let a stale close deactivate a replacement policy", () => {
    const first = installAtomicFinalResponsePolicy("enforce");
    first.close();
    const second = installAtomicFinalResponsePolicy("enforce");
    close = second.close;
    first.close();
    expect(
      resolveAtomicFinalResponsePolicy({
        trigger: "user",
        disableTools: true,
        clientToolCount: 0,
        resolvedThinkLevel: "high",
      }),
    ).toBeDefined();
  });
});
