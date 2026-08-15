import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FunctionalFinnMemoryRecord } from "./memory-ledger.js";
import { materializeFunctionalFinnMemory } from "./memory-materializer.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

function record(generation: number, claim: string): FunctionalFinnMemoryRecord {
  return {
    schemaVersion: 1,
    agentId: "finn",
    factKey: "service.status",
    generation,
    state: "verified_current",
    claim,
    sourceKind: "tool_observation",
    evidenceId: `e${generation}`,
    sourceEvidenceIds: [`e${generation}`],
    observedAt: generation,
    freshnessUntil: 10_000,
    confidence: 1,
    authority: 80,
    revisionDigest: `digest-${generation}`,
    remediation: "pending",
    history: [],
  };
}

describe("Functional Finn memory materializer", () => {
  it("serializes one workspace and leaves the newest projection", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "functional-finn-memory-"));
    directories.push(workspaceDir);
    const first = materializeFunctionalFinnMemory({
      workspaceDir,
      loadRecords: () => [record(1, "Service is degraded.")],
    });
    const second = materializeFunctionalFinnMemory({
      workspaceDir,
      loadRecords: () => [record(2, "Service is healthy.")],
    });
    await Promise.all([first, second]);
    const rendered = await fs.readFile(
      path.join(workspaceDir, "memory", "verified", "functional-finn.md"),
      "utf8",
    );
    expect(rendered).toContain("Service is healthy.");
    expect(rendered).not.toContain("degraded");
  });
});
