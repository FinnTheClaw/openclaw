import { afterEach, describe, expect, it } from "vitest";
import { isOwnedGovernorMemoryCapability } from "./memory-governor-capability.js";
import {
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
  registerTrustedMemoryCapability,
  type MemoryPluginCapability,
} from "./memory-state.js";

afterEach(() => clearMemoryPluginState());

function capability(onBackend: (key: string | undefined) => void): MemoryPluginCapability {
  return {
    governorMemory: {
      createBackend: ({ authorityBindingKey }) => {
        onBackend(authorityBindingKey);
        return {
          admit: async () => ({ status: "admitted" as const }),
          recall: async () => [],
          invalidate: async () => undefined,
          compact: async () => ({ compacted: 0, retainedHighWater: 0 }),
        };
      },
    },
  };
}

describe("governor memory capability provenance", () => {
  it("does not elevate config-origin or direct registrations", () => {
    const onBackend = () => undefined;
    const candidate = capability(onBackend);

    registerMemoryCapability("memory-lancedb", candidate);
    expect(getMemoryCapabilityRegistration()?.capability.governorMemory).toBeUndefined();

    registerTrustedMemoryCapability("memory-lancedb", candidate, {
      origin: "config",
      source: "C:/untrusted/memory-lancedb/index.js",
    });
    expect(getMemoryCapabilityRegistration()?.capability.governorMemory).toBeUndefined();
  });

  it("brands only the bundled implementation before the lifecycle can pass a signing key", () => {
    const keys: Array<string | undefined> = [];
    registerTrustedMemoryCapability(
      "memory-lancedb",
      capability((key) => keys.push(key)),
      {
        origin: "bundled",
        source: "extensions/memory-lancedb/index.ts",
      },
    );

    const registered = getMemoryCapabilityRegistration()?.capability.governorMemory;
    expect(registered && isOwnedGovernorMemoryCapability(registered)).toBe(true);
    registered?.createBackend({ mode: "enforce", authorityBindingKey: "fixture-ledger-key" });
    expect(keys).toEqual(["fixture-ledger-key"]);
  });
});
