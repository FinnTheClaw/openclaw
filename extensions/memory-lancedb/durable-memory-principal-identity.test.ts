import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableMemoryRuntime, resolveDurableMemoryAgentId } from "./durable-memory-runtime.js";

function embedding(text: string): number[] {
  const vector = Array.from({ length: 8 }, () => 0);
  for (let index = 0; index < text.length; index++) {
    vector[text.charCodeAt(index) % vector.length]! += 1;
  }
  return vector;
}

describe("durable memory storage principal identity", () => {
  let tmpDir = "";
  let runtime: DurableMemoryRuntime | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-principal-"));
    runtime = new DurableMemoryRuntime({
      ledgerPath: path.join(tmpDir, "ledger.sqlite3"),
      projectionPath: path.join(tmpDir, "projection"),
      vectorDimensions: 8,
      embeddings: { embed: async (text) => embedding(text) },
      logger: {},
    });
  });

  afterEach(async () => {
    await runtime?.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves the exact host-issued SHA-256 principal across capture and recall", async () => {
    const principal = `principal_${"a".repeat(64)}`;
    const truncated = principal.slice(0, 64);

    expect(resolveDurableMemoryAgentId(principal, undefined)).toBe(principal);
    expect(
      runtime!.captureInbound({
        agentId: principal,
        content: "The synthetic orchard marker is blueberry.",
        messageId: "principal-full-id",
      }),
    ).toBe(true);
    expect(runtime!.ledger.listRecentEvents({ agentId: principal })).toHaveLength(1);
    expect(runtime!.ledger.listRecentEvents({ agentId: truncated })).toHaveLength(0);

    expect(await runtime!.flush()).toBe(true);
    const [event] = runtime!.ledger.listRecentEvents({ agentId: principal });
    expect(event).toBeDefined();
    expect(await runtime!.index.has(event!.eventId, { agentId: principal })).toBe(true);
    expect(await runtime!.index.has(event!.eventId, { agentId: truncated })).toBe(false);
  });

  it("rekeys a legacy truncated ledger and projection once the exact principal is known", async () => {
    const principal = `principal_${"b".repeat(64)}`;
    const truncated = principal.slice(0, 64);
    const legacy = runtime!.ledger.appendEvent({
      agentId: truncated,
      role: "user",
      content: "Legacy direct evidence.",
      sourceKind: "message_received",
      externalId: "legacy-principal-event",
    });
    const canonical = runtime!.captureManualMemory({
      agentId: principal,
      text: "Canonical principal marker.",
      externalId: "canonical-principal-event",
    });
    const sharedFact = {
      factKey: "fact_shared_principal_marker",
      scope: "scope_shared_principal_marker",
      subject: "synthetic marker",
      predicate: "has value",
      object: "blueberry",
      text: "The synthetic marker has value blueberry.",
      category: "fact",
      confidence: 0.9,
    } as const;
    const legacyFact = runtime!.ledger.appendFactRevision({
      ...sharedFact,
      agentId: truncated,
      authority: 0.7,
      observedAt: 100,
      validFrom: 100,
      sourceEventId: legacy.event.eventId,
    });
    const canonicalFact = runtime!.ledger.appendFactRevision({
      ...sharedFact,
      agentId: principal,
      authority: 0.9,
      observedAt: 200,
      validFrom: 200,
      sourceEventId: canonical.id,
    });
    expect(await runtime!.flush()).toBe(true);

    expect(await runtime!.repairLegacyTruncatedPrincipalProjections()).toBe(1);
    expect(runtime!.ledger.listRecentEvents({ agentId: truncated })).toHaveLength(0);
    expect(runtime!.ledger.listRecentEvents({ agentId: principal })).toHaveLength(2);
    expect(await runtime!.index.has(legacy.event.eventId, { agentId: principal })).toBe(true);
    expect(await runtime!.index.has(legacy.event.eventId, { agentId: truncated })).toBe(false);
    expect(
      runtime!.ledger.findCurrentFacts({
        agentId: principal,
        scope: sharedFact.scope,
        factKey: sharedFact.factKey,
      }),
    ).toEqual([expect.objectContaining({ revisionId: canonicalFact.fact.revisionId })]);
    expect(runtime!.ledger.getFactRevision(legacyFact.fact.revisionId)).toMatchObject({
      agentId: principal,
      status: "superseded",
      supersedesRevisionId: canonicalFact.fact.revisionId,
    });
  });
});
