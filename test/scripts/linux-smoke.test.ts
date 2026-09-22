import { describe, expect, it } from "vitest";
import { resolveLinuxSmokeInstallVersion } from "../../scripts/e2e/parallels/linux-smoke.ts";

describe("Linux smoke install baseline", () => {
  it.each([
    {
      expected: "2026.6.35",
      installVersion: "2026.6.35",
      latestVersion: "2026.7.2",
    },
    { expected: "2026.7.2", installVersion: "", latestVersion: "2026.7.2" },
  ])("verifies $expected", ({ expected, installVersion, latestVersion }) => {
    expect(resolveLinuxSmokeInstallVersion(installVersion, latestVersion)).toBe(expected);
  });
});
