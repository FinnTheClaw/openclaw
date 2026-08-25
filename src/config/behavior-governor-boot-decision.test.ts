import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  assertBehaviorGovernorConfigMatchesBootDecision,
  deriveBehaviorGovernorBootDecision,
} from "./behavior-governor-boot-decision.js";

const refs = {
  identityHmacKey: { source: "env", provider: "default", id: "GOV_IDENTITY" },
  evidenceAdmissionKey: { source: "env", provider: "default", id: "GOV_EVIDENCE" },
  receiptSigningKey: { source: "env", provider: "default", id: "GOV_RECEIPT" },
  ledgerSigningKey: { source: "env", provider: "default", id: "GOV_LEDGER" },
  deploymentIdentity: { source: "env", provider: "default", id: "GOV_DEPLOYMENT" },
} as const;

function config(mode: "shadow" | "enforce" = "shadow"): OpenClawConfig {
  return {
    experimental: {
      behaviorGovernor: {
        enabled: true,
        mode,
        secretRefs: refs,
        agentLoop: {
          scopes: [{ sessionKey: "fixture" }],
          criteria: [],
          toolBindings: [],
          maxTurns: 3,
        },
      },
    },
  };
}

function enabledGovernor(value: OpenClawConfig) {
  const governor = value.experimental?.behaviorGovernor;
  if (!governor?.enabled) {
    throw new Error("expected enabled governor fixture");
  }
  return governor;
}

describe("behavior governor boot decision", () => {
  it("creates one getter-free recursively frozen branded shadow decision", () => {
    const decision = deriveBehaviorGovernorBootDecision(config());
    expect(decision.kind).toBe("shadow");
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.kind !== "shadow") {
      throw new Error("expected shadow decision");
    }
    expect(Object.isFrozen(decision.config.agentLoop.scopes[0])).toBe(true);
    expect(
      Object.values(Object.getOwnPropertyDescriptors(decision)).every(
        (descriptor) => "value" in descriptor,
      ),
    ).toBe(true);
    expect(() => {
      (decision.config.agentLoop as { maxTurns: number }).maxTurns = 9;
    }).toThrow();
  });

  it("fails closed on enforce before reading nested accessors", () => {
    const enforce = config("enforce");
    let getterCalled = false;
    Object.defineProperty(enforce.experimental!.behaviorGovernor!, "agentLoop", {
      get: () => {
        getterCalled = true;
        throw new Error("getter executed");
      },
      enumerable: true,
    });
    expect(() => deriveBehaviorGovernorBootDecision(enforce)).toThrow("C07_ARCHITECTURE_NOT_READY");
    expect(getterCalled).toBe(false);
    expect(() => deriveBehaviorGovernorBootDecision(config("enforce"))).toThrow(
      "C07_ARCHITECTURE_NOT_READY",
    );
  });

  it("rejects getters, sparse arrays, and executable values in a shadow snapshot", () => {
    const accessor = config();
    Object.defineProperty(accessor.experimental!.behaviorGovernor!, "agentLoop", {
      get: () => ({ scopes: [], criteria: [], toolBindings: [], maxTurns: 3 }),
      enumerable: true,
    });
    expect(() => deriveBehaviorGovernorBootDecision(accessor)).toThrow(
      "GOVERNOR_BOOT_CONFIG_ACCESSOR_REJECTED",
    );

    const sparse = config();
    (enabledGovernor(sparse).agentLoop as unknown as { scopes: unknown[] }).scopes = new Array(1);
    expect(() => deriveBehaviorGovernorBootDecision(sparse)).toThrow(
      "GOVERNOR_BOOT_CONFIG_DESCRIPTOR_REJECTED",
    );

    const executable = config() as OpenClawConfig & { injected?: unknown };
    (executable.experimental!.behaviorGovernor as unknown as { injected: unknown }).injected =
      () => undefined;
    expect(() => deriveBehaviorGovernorBootDecision(executable)).toThrow(
      "GOVERNOR_BOOT_CONFIG_VALUE_REJECTED",
    );
  });

  it("does not follow inherited governor configuration", () => {
    let getterCalled = false;
    const inherited = Object.create({
      get experimental() {
        getterCalled = true;
        return { behaviorGovernor: config().experimental?.behaviorGovernor };
      },
    }) as OpenClawConfig;

    expect(deriveBehaviorGovernorBootDecision(inherited)).toMatchObject({ kind: "off" });
    expect(getterCalled).toBe(false);
  });

  it("rejects a changed snapshot without replacing the boot decision", () => {
    const decision = deriveBehaviorGovernorBootDecision(config());
    const changed = config();
    const changedGovernor = enabledGovernor(changed);
    changed.experimental!.behaviorGovernor = {
      ...changedGovernor,
      agentLoop: { ...changedGovernor.agentLoop, maxTurns: 4 },
    };
    expect(() => assertBehaviorGovernorConfigMatchesBootDecision(decision, config())).not.toThrow();
    expect(() => assertBehaviorGovernorConfigMatchesBootDecision(decision, changed)).toThrow(
      "GOVERNOR_GATEWAY_RESTART_REQUIRED",
    );
  });
});
