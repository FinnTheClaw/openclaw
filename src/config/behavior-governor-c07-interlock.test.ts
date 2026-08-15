import { describe, expect, it } from "vitest";
import {
  C07_ARCHITECTURE_NOT_READY,
  C07_IMPLEMENTED_ARCHITECTURE_VERSION,
  C07_REQUIRED_ARCHITECTURE_VERSION,
  assertC07ArchitectureReady,
  assertC07MemoryBackendUnavailable,
  isC07EnforceRequested,
} from "./behavior-governor-c07-interlock.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function config(mode?: "shadow" | "enforce"): OpenClawConfig {
  return {
    experimental: {
      behaviorGovernor: mode ? { enabled: true, mode } : { enabled: false },
    },
  } as OpenClawConfig;
}

describe("C07 architecture activation interlock", () => {
  it("keeps absent, OFF, and shadow configurations inert", () => {
    const absent = {} as OpenClawConfig;
    for (const candidate of [absent, config(), config("shadow")]) {
      expect(isC07EnforceRequested(candidate)).toBe(false);
      expect(() => assertC07ArchitectureReady(candidate)).not.toThrow();
    }
  });

  it("rejects enforce until every approved architecture slice is implemented", () => {
    expect(C07_IMPLEMENTED_ARCHITECTURE_VERSION).toBeLessThan(C07_REQUIRED_ARCHITECTURE_VERSION);
    expect(isC07EnforceRequested(config("enforce"))).toBe(true);
    expect(() => assertC07ArchitectureReady(config("enforce"))).toThrow(C07_ARCHITECTURE_NOT_READY);
  });

  it("rejects every lower-boundary memory backend while allowing absence", () => {
    expect(() => assertC07MemoryBackendUnavailable(undefined)).not.toThrow();
    expect(() => assertC07MemoryBackendUnavailable({})).toThrow(C07_ARCHITECTURE_NOT_READY);
    expect(() => assertC07MemoryBackendUnavailable(null)).toThrow(C07_ARCHITECTURE_NOT_READY);
  });
});
