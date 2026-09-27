import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGovernorMemoryRetirementDecision,
  isOwnedGovernorMemoryBackend,
  verifyGovernorMemoryRetirementDecision,
} from "./memory-governor-capability.js";
import {
  claimGovernorMemoryFactoryOwner,
  createRegisteredGovernorMemoryBackend,
} from "./memory-governor-private.js";
import {
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.js";

const factoryOwner = claimGovernorMemoryFactoryOwner();

afterEach(() => {
  factoryOwner.clear();
  clearMemoryPluginState();
});

const backend = () => ({
  admit: async () => ({ status: "rejected" as const, reason: "fixture" }),
  recall: async () => [],
  invalidate: async () => {
    throw new Error("unused");
  },
  compact: async () => ({ compacted: 0, retainedHighWater: 0 }),
});

function bundledProvenance() {
  const rootDir = path.resolve(import.meta.dirname, "../../extensions/memory-lancedb");
  return {
    id: "memory-lancedb",
    origin: "bundled",
    rootDir,
    source: path.join(rootDir, "index.ts"),
  };
}

describe("governor memory private capability provenance", () => {
  it.each(["expiry", "explicit_forget"] as const)(
    "authenticates the closed %s retirement reason",
    (reason) => {
      const key = "retirement-reason-fixture-key";
      const decision = createGovernorMemoryRetirementDecision(
        {
          scopeKey: "scope-a",
          factKey: "fact-a",
          staleMemoryId: "memory-a",
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 120,
          issuedAt: 130,
          reason,
          priorAuthorityBindingDigest: "a".repeat(64),
        },
        key,
      );
      expect(verifyGovernorMemoryRetirementDecision(decision, key)).toBe(true);
      expect(
        verifyGovernorMemoryRetirementDecision(
          { ...decision, semanticCutoff: decision.semanticCutoff + 1 },
          key,
        ),
      ).toBe(false);
    },
  );

  it("rejects reasons outside the closed retirement domain", () => {
    expect(() =>
      createGovernorMemoryRetirementDecision(
        {
          scopeKey: "scope-a",
          factKey: "fact-a",
          staleMemoryId: "memory-a",
          priorGeneration: 1,
          newGeneration: 2,
          semanticCutoff: 120,
          issuedAt: 130,
          reason: "contradiction" as never,
          priorAuthorityBindingDigest: "a".repeat(64),
        },
        "retirement-reason-fixture-key",
      ),
    ).toThrow("GOVERNOR_MEMORY_RETIREMENT_DECISION_INVALID");
  });

  it("never exposes a caller-supplied factory through public capability state", () => {
    registerMemoryCapability("memory-lancedb", {
      governorMemory: { createBackend: backend },
    } as never);

    expect(getMemoryCapabilityRegistration()?.capability).not.toHaveProperty("governorMemory");
    expect(
      createRegisteredGovernorMemoryBackend({
        mode: "enforce",
        authorityBindingKey: "fixture-ledger-key",
      }),
    ).toBeUndefined();
  });

  it("allows only the exact bundled loader registrar and closes retained handles", () => {
    const registration = factoryOwner.createRegistrationHost(bundledProvenance());
    const keys: string[] = [];
    registration.host?.register(({ authorityBindingKey }) => {
      keys.push(authorityBindingKey);
      return backend();
    });
    registration.commit();
    registration.close();

    const owned = createRegisteredGovernorMemoryBackend({
      mode: "enforce",
      authorityBindingKey: "fixture-ledger-key",
    });
    expect(isOwnedGovernorMemoryBackend(owned)).toBe(true);
    expect(keys).toEqual(["fixture-ledger-key"]);
    expect(() => registration.host?.register(backend)).toThrow(
      "GOVERNOR_MEMORY_PRIVATE_REGISTRATION_CLOSED",
    );
  });

  it("does not let a second in-process caller mint registration authority", () => {
    expect(() => claimGovernorMemoryFactoryOwner()).toThrow(
      "GOVERNOR_MEMORY_FACTORY_OWNER_ALREADY_CLAIMED",
    );
  });

  it.each([
    ["config origin", { ...bundledProvenance(), origin: "config" }],
    ["wrong id", { ...bundledProvenance(), id: "memory-other" }],
    ["wrong root", { ...bundledProvenance(), rootDir: import.meta.dirname }],
    [
      "outside source",
      { ...bundledProvenance(), source: path.join(import.meta.dirname, "memory-state.ts") },
    ],
  ])("rejects %s provenance", (_label, provenance) => {
    expect(factoryOwner.createRegistrationHost(provenance).host).toBeUndefined();
  });

  it("keeps factory and key selection out of public SDK and package exports", () => {
    const sdk = fs.readFileSync(
      path.resolve(import.meta.dirname, "../plugin-sdk/memory-core-host-runtime-core.ts"),
      "utf8",
    );
    const manifest = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../package.json"),
      "utf8",
    );
    expect(sdk).not.toMatch(
      /MemoryGovernorCapability|authorityBindingKey|memory-governor-private/u,
    );
    expect(manifest).not.toContain("memory-governor-private");
  });
});
