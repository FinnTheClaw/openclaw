import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const authorityImport =
  /security\/governor-host-(?:anti-rollback-ledger|broker|persistence)(?:\.js)?["']/u;
const forbiddenAuthority =
  /\b(?:createHostGovernorBroker|createGovernorHostPersistence|GovernorHostPersistence|HostGovernorCapabilities|signApprovalGrant|registerStaticDeliveryAdapter|revokeDeliveryAdapter)\b/u;

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(target)
      : target.endsWith(".ts") && !target.endsWith(".test.ts")
        ? [target]
        : [];
  });
}

describe("governor host authority boundary", () => {
  it("keeps the capability kernel out of task, model, and plugin modules", () => {
    const guarded = ["tasks", "agents", "plugins", "extensions"].flatMap((name) => {
      const target = path.join(root, name);
      return fs.existsSync(target) ? files(target) : [];
    });
    for (const file of guarded) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toMatch(authorityImport);
      expect(source, file).not.toMatch(forbiddenAuthority);
    }
  });

  it("keeps host authority and test-only bridge out of package exports", () => {
    const manifest = fs.readFileSync(path.join(root, "..", "package.json"), "utf8");
    expect(manifest).not.toContain("governor-host-broker");
    expect(manifest).not.toContain("governor-host-persistence");
    expect(manifest).not.toContain("governor-host-anti-rollback-ledger");
    expect(manifest).not.toContain("governor-host-readonly");
  });
});
