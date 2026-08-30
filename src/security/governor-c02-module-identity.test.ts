import { describe, expect, it } from "vitest";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import { isExactGovernorC02Module } from "./governor-c02-module-identity.js";

const base = {
  mode: "enforce",
  scopes: [{ sessionKey: "session" }],
  criteria: [],
  toolBindings: [],
  maxTurns: 1,
} as const satisfies GovernorAgentLoopConfiguration;

describe("C02 module identity isolation", () => {
  it("enables C02-only behavior solely for the exact id and version", () => {
    expect(
      isExactGovernorC02Module({
        ...base,
        moduleIdentity: { id: "c02-simple-efficiency", version: "v1" },
      }),
    ).toBe(true);
    for (const config of [
      base,
      { ...base, moduleIdentity: { id: "other", version: "v1" } },
      { ...base, moduleIdentity: { id: "c02-simple-efficiency", version: "v2" } },
      {
        ...base,
        toolBindings: [
          {
            toolName: "read",
            capability: "read",
            canonicalTarget: "test://read",
            implementationId: "installed-tool:read" as const,
          },
          {
            toolName: "exec",
            capability: "exec",
            canonicalTarget: "test://exec",
            implementationId: "installed-tool:exec" as const,
          },
        ],
      },
    ]) {
      expect(isExactGovernorC02Module(config)).toBe(false);
    }
  });
});
