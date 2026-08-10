import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { HybridMemoryIndex, type MemoryProjectionInput } from "./hybrid-memory-index.js";
import { memoryScopeMetadata, resolveTrustedMemoryScope } from "./memory-scope.js";
import { TemporalMemoryLedger } from "./temporal-ledger.js";

export type MemoryScaleCertificationOptions = {
  facts?: number;
  queries?: number;
  directory?: string;
  keep?: boolean;
};

export type MemoryScaleCertificationReport = {
  status: "PASS" | "FAIL";
  facts: number;
  queries: number;
  recallFailures: Array<{ expected: string; actual?: string }>;
  recallAt1: number;
  queryLatencyMs: { median: number; p95: number; max: number };
  ingestMs: number;
  indexMs: number;
  ledgerIntegrity: ReturnType<TemporalMemoryLedger["verifyIntegrity"]>;
  ledgerStats: ReturnType<TemporalMemoryLedger["getStats"]>;
  reopenStats: ReturnType<TemporalMemoryLedger["getStats"]>;
  indexStats: Awaited<ReturnType<HybridMemoryIndex["getStats"]>>;
  fullyIndexed: boolean;
  bytesOnDisk: number;
  directory: string;
  snapshotPath: string;
};

export type MemoryIsolationCertificationOptions = {
  /** Total private rows. Must be even so every collision has one row per principal. */
  facts?: number;
  queries?: number;
  directory?: string;
  keep?: boolean;
};

export type MemoryIsolationCertificationReport = {
  status: "PASS" | "FAIL";
  facts: number;
  queries: number;
  principals: number;
  conversationsPerPrincipal: number;
  authorizedRecallFailures: number;
  crossPrincipalViolations: number;
  crossConversationViolations: number;
  principalFactFailures: number;
  deletionFailures: number;
  reopenFailures: number;
  secretCanaryMatches: number;
  ledgerIntegrity: ReturnType<TemporalMemoryLedger["verifyIntegrity"]>;
  ledgerStats: ReturnType<TemporalMemoryLedger["getStats"]>;
  reopenStats: ReturnType<TemporalMemoryLedger["getStats"]>;
  indexStats: Awaited<ReturnType<HybridMemoryIndex["getStats"]>>;
  queryLatencyMs: { median: number; p95: number; max: number };
  directory: string;
};

function validateCount(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function vector(text: string, dimensions = 64): number[] {
  const bytes = createHash("sha256").update(text).digest();
  const values = Array.from({ length: dimensions }, (_, index) => {
    const value = bytes[index % bytes.length]! / 255;
    return index % 2 === 0 ? value : -value;
  });
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / magnitude);
}

function percentile(values: number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      total += (await fs.stat(full)).size;
    }
  }
  return total;
}

function factText(index: number): string {
  const token = `ZX-${index.toString(36).toUpperCase().padStart(8, "0")}-MEMORY`;
  return `Asset ${index} uses verification token ${token} and maintenance circuit ${index % 97}.`;
}

function collisionText(index: number): string {
  const token = `ISO-${index.toString(36).toUpperCase().padStart(8, "0")}-PAIR`;
  return `Collision record ${index} carries private verification token ${token}.`;
}

function containsEntryId(
  results: Awaited<ReturnType<HybridMemoryIndex["search"]>>,
  id: string,
): boolean {
  return results.some((result) => result.entry.id === id);
}

export async function runMemoryScaleCertification(
  options: MemoryScaleCertificationOptions = {},
): Promise<MemoryScaleCertificationReport> {
  const facts = validateCount(options.facts ?? 25_000, "facts", 1_000, 2_000_000);
  const queries = validateCount(options.queries ?? 200, "queries", 1, 10_000);
  const ephemeral = !options.directory;
  const directory = options.directory
    ? path.resolve(options.directory)
    : await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-scale-cert-"));
  await fs.mkdir(directory, { recursive: true });
  const ledgerPath = path.join(directory, "ledger.sqlite3");
  const projectionPath = path.join(directory, "lance");
  const ledger = new TemporalMemoryLedger(ledgerPath);
  const index = new HybridMemoryIndex(projectionPath, 64);

  try {
    const ingestStarted = performance.now();
    for (let start = 0; start < facts; start += 10_000) {
      const count = Math.min(10_000, facts - start);
      ledger.appendEvents(
        Array.from({ length: count }, (_, offset) => {
          const factIndex = start + offset;
          return {
            agentId: "jake",
            role: "user" as const,
            content: factText(factIndex),
            sourceKind: "scale_cert",
            externalId: `scale-${factIndex}`,
            observedAt: 1_700_000_000_000 + factIndex,
          };
        }),
      );
    }
    const ingestMs = performance.now() - ingestStarted;

    const indexStarted = performance.now();
    for (let start = 0; start < facts; start += 10_000) {
      const count = Math.min(10_000, facts - start);
      const rows: MemoryProjectionInput[] = Array.from({ length: count }, (_, offset) => {
        const factIndex = start + offset;
        const text = factText(factIndex);
        return {
          id: `fact-${factIndex}`,
          recordType: "fact",
          text,
          vector: vector(text),
          agentId: "jake",
          scope: "global",
          factKey: `asset-${factIndex}-verification`,
          category: "fact",
          status: "active",
          importance: 0.8,
          confidence: 1,
          authority: 1,
          validFrom: 1_700_000_000_000 + factIndex,
          observedAt: 1_700_000_000_000 + factIndex,
          sourceEventId: `scale-${factIndex}`,
        };
      });
      await index.upsertBatch(rows);
    }
    await index.ensureIndices({ force: true });
    await index.optimizeIfNeeded(1);
    const indexMs = performance.now() - indexStarted;

    let seed = 0x5a17;
    const nextIndex = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % facts;
    };
    const latencies: number[] = [];
    const failures: Array<{ expected: string; actual?: string }> = [];
    for (let queryIndex = 0; queryIndex < queries; queryIndex++) {
      const target = nextIndex();
      const token = `ZX-${target.toString(36).toUpperCase().padStart(8, "0")}-MEMORY`;
      const started = performance.now();
      const results = await index.search({
        agentId: "jake",
        queryText: `Which asset uses verification token ${token}?`,
        vector: vector(factText(target)),
        validAt: 1_800_000_000_000,
        limit: 5,
      });
      latencies.push(performance.now() - started);
      if (results[0]?.entry.id !== `fact-${target}` || results.length > 5) {
        failures.push({ expected: `fact-${target}`, actual: results[0]?.entry.id });
      }
    }

    const ledgerIntegrity = ledger.verifyIntegrity();
    const ledgerStats = ledger.getStats();
    const indexStats = await index.getStats();
    const fullyIndexed = indexStats.indices.every((entry) => (entry.unindexedRows ?? 0) === 0);
    index.close();
    ledger.close();

    const reopened = new TemporalMemoryLedger(ledgerPath);
    const reopenStats = reopened.getStats();
    const snapshotPath = path.join(directory, "ledger-snapshot.sqlite3");
    reopened.createSnapshot(snapshotPath);
    reopened.close();

    const report: MemoryScaleCertificationReport = {
      status:
        failures.length === 0 &&
        ledgerIntegrity.ok &&
        fullyIndexed &&
        indexStats.rows === facts &&
        ledgerStats.events === facts &&
        reopenStats.events === facts
          ? "PASS"
          : "FAIL",
      facts,
      queries,
      recallFailures: failures.slice(0, 20),
      recallAt1: (queries - failures.length) / queries,
      queryLatencyMs: {
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: Math.max(...latencies),
      },
      ingestMs,
      indexMs,
      ledgerIntegrity,
      ledgerStats,
      reopenStats,
      indexStats,
      fullyIndexed,
      bytesOnDisk: await directoryBytes(directory),
      directory,
      snapshotPath,
    };
    if (ephemeral && !options.keep) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return report;
  } catch (error) {
    index.close();
    ledger.close();
    if (ephemeral && !options.keep) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Exercise the exact opaque owner/scope boundary used by live durable memory.
 * This deliberately uses deterministic local embeddings and a dedicated
 * directory so certification sends no model or channel traffic.
 */
export async function runMemoryIsolationCertification(
  options: MemoryIsolationCertificationOptions = {},
): Promise<MemoryIsolationCertificationReport> {
  const facts = validateCount(options.facts ?? 4_000, "facts", 1_000, 2_000_000);
  if (facts % 2 !== 0) {
    throw new Error("facts must be even so each collision has one row per principal");
  }
  const queries = validateCount(options.queries ?? 100, "queries", 1, 10_000);
  const ephemeral = !options.directory;
  const directory = options.directory
    ? path.resolve(options.directory)
    : await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-isolation-cert-"));
  await fs.mkdir(directory, { recursive: true });

  const ledgerPath = path.join(directory, "ledger.sqlite3");
  const projectionPath = path.join(directory, "lance");
  const ledger = new TemporalMemoryLedger(ledgerPath);
  let index = new HybridMemoryIndex(projectionPath, 64);
  const secretCanary = "fake-hmac-secret-canary-never-expose";
  const workspaces = [
    path.join(directory, "workspace-owner"),
    path.join(directory, "workspace-member"),
  ];
  const principals = ["cert-owner", "cert-member"];
  const channels = ["signal", "signal", "whatsapp"];
  const conversationIds = ["direct-a", "direct-b", "direct-c"];
  const scopes = principals.map((agentId, principalIndex) =>
    conversationIds.map((conversationId, conversationIndex) =>
      resolveTrustedMemoryScope({
        agentId,
        workspaceDir: workspaces[principalIndex]!,
        sessionId: `session-${principalIndex}-${conversationIndex}`,
        channel: channels[conversationIndex],
        accountId: "default",
        conversationId,
      }),
    ),
  );

  const rows: MemoryProjectionInput[] = [];
  const eventInputs: Parameters<TemporalMemoryLedger["appendEvents"]>[0] = [];
  const pairCount = facts / 2;
  const observedBase = 1_700_100_000_000;
  for (let pair = 0; pair < pairCount; pair++) {
    const conversationIndex = pair % conversationIds.length;
    const text = collisionText(pair);
    for (let principalIndex = 0; principalIndex < principals.length; principalIndex++) {
      const scope = scopes[principalIndex]![conversationIndex]!;
      const id = `private-${principalIndex}-${pair}`;
      rows.push({
        id,
        recordType: "event",
        text,
        vector: vector(text),
        agentId: scope.storageAgentId,
        scope: scope.conversationScope,
        sessionKey: scope.sessionRef,
        channel: scope.channel,
        conversationId: scope.conversationRef,
        category: "certification",
        status: "active",
        importance: 0.8,
        confidence: 1,
        authority: 1,
        validFrom: observedBase + pair,
        observedAt: observedBase + pair,
        sourceEventId: `isolation-${principalIndex}-${pair}`,
      });
      eventInputs.push({
        externalId: `isolation-${principalIndex}-${pair}`,
        agentId: scope.storageAgentId,
        sessionKey: scope.sessionRef,
        channel: scope.channel,
        conversationId: scope.conversationRef,
        role: "user",
        content: text,
        sourceKind: "isolation_cert",
        observedAt: observedBase + pair,
        metadata: memoryScopeMetadata(scope, "direct_user"),
      });
    }
  }

  const principalRows = principals.map((_, principalIndex) => {
    const scope = scopes[principalIndex]![0]!;
    const text = `Verified principal ${principalIndex} uses durable certification policy P${principalIndex}.`;
    return {
      id: `principal-${principalIndex}`,
      recordType: "fact" as const,
      text,
      vector: vector(text),
      agentId: scope.storageAgentId,
      scope: scope.principalScope,
      factKey: "certification-policy",
      category: "identity",
      status: "active" as const,
      importance: 1,
      confidence: 1,
      authority: 1,
      validFrom: observedBase,
      observedAt: observedBase,
      sourceEventId: `principal-evidence-${principalIndex}`,
    };
  });
  rows.push(...principalRows);

  const latencies: number[] = [];
  let authorizedRecallFailures = 0;
  let crossPrincipalViolations = 0;
  let crossConversationViolations = 0;
  let principalFactFailures = 0;
  let deletionFailures = 0;
  let reopenFailures = 0;

  const searchFor = async (params: {
    text: string;
    agentId: string;
    scope: string;
    limit?: number;
  }) => {
    const started = performance.now();
    const results = await index.search({
      queryText: params.text,
      vector: vector(params.text),
      agentId: params.agentId,
      scope: params.scope,
      validAt: 1_800_000_000_000,
      limit: params.limit ?? 5,
    });
    latencies.push(performance.now() - started);
    return results;
  };

  try {
    for (let start = 0; start < eventInputs.length; start += 10_000) {
      ledger.appendEvents(eventInputs.slice(start, start + 10_000));
    }
    for (let start = 0; start < rows.length; start += 10_000) {
      await index.upsertBatch(rows.slice(start, start + 10_000));
    }
    await index.ensureIndices({ force: true });
    await index.optimizeIfNeeded(1);

    let seed = 0x51a7;
    const nextPair = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % pairCount;
    };
    for (let queryIndex = 0; queryIndex < queries; queryIndex++) {
      const pair = nextPair();
      const principalIndex = queryIndex % principals.length;
      const conversationIndex = pair % conversationIds.length;
      const otherPrincipal = 1 - principalIndex;
      const wrongConversation = (conversationIndex + 1) % conversationIds.length;
      const scope = scopes[principalIndex]![conversationIndex]!;
      const otherScope = scopes[otherPrincipal]![conversationIndex]!;
      const wrongScope = scopes[principalIndex]![wrongConversation]!;
      const text = collisionText(pair);
      const expectedId = `private-${principalIndex}-${pair}`;

      const authorized = await searchFor({
        text,
        agentId: scope.storageAgentId,
        scope: scope.conversationScope,
      });
      if (authorized[0]?.entry.id !== expectedId) {
        authorizedRecallFailures += 1;
      }

      const crossPrincipal = await searchFor({
        text,
        agentId: otherScope.storageAgentId,
        scope: otherScope.conversationScope,
      });
      if (
        containsEntryId(crossPrincipal, expectedId) ||
        crossPrincipal.some((result) => result.entry.agentId !== otherScope.storageAgentId)
      ) {
        crossPrincipalViolations += 1;
      }

      const crossConversation = await searchFor({
        text,
        agentId: wrongScope.storageAgentId,
        scope: wrongScope.conversationScope,
      });
      if (containsEntryId(crossConversation, expectedId)) {
        crossConversationViolations += 1;
      }
    }

    for (let principalIndex = 0; principalIndex < principals.length; principalIndex++) {
      const sourceScope = scopes[principalIndex]![0]!;
      const otherChannelScope = scopes[principalIndex]![2]!;
      const principalRow = principalRows[principalIndex]!;
      const results = await searchFor({
        text: principalRow.text,
        agentId: otherChannelScope.storageAgentId,
        scope: otherChannelScope.principalScope,
      });
      if (results[0]?.entry.id !== principalRow.id) {
        principalFactFailures += 1;
      }
      if (
        sourceScope.storageAgentId !== otherChannelScope.storageAgentId ||
        sourceScope.principalScope !== otherChannelScope.principalScope ||
        sourceScope.conversationScope === otherChannelScope.conversationScope
      ) {
        principalFactFailures += 1;
      }
    }

    const deletePair = Math.min(7, pairCount - 1);
    const deleteConversation = deletePair % conversationIds.length;
    const ownerScope = scopes[0]![deleteConversation]!;
    const memberScope = scopes[1]![deleteConversation]!;
    const deleteText = collisionText(deletePair);
    const ownerId = `private-0-${deletePair}`;
    const memberId = `private-1-${deletePair}`;
    if (!(await index.delete(ownerId))) {
      deletionFailures += 1;
    }
    if (
      containsEntryId(
        await searchFor({
          text: deleteText,
          agentId: ownerScope.storageAgentId,
          scope: ownerScope.conversationScope,
        }),
        ownerId,
      )
    ) {
      deletionFailures += 1;
    }
    if (
      !containsEntryId(
        await searchFor({
          text: deleteText,
          agentId: memberScope.storageAgentId,
          scope: memberScope.conversationScope,
        }),
        memberId,
      )
    ) {
      deletionFailures += 1;
    }

    const ledgerIntegrity = ledger.verifyIntegrity();
    const ledgerStats = ledger.getStats();
    const indexStats = await index.getStats();
    index.close();
    ledger.close();

    const reopenedLedger = new TemporalMemoryLedger(ledgerPath);
    const reopenStats = reopenedLedger.getStats();
    reopenedLedger.close();
    index = new HybridMemoryIndex(projectionPath, 64);
    if (
      containsEntryId(
        await searchFor({
          text: deleteText,
          agentId: ownerScope.storageAgentId,
          scope: ownerScope.conversationScope,
        }),
        ownerId,
      )
    ) {
      reopenFailures += 1;
    }
    if (
      !containsEntryId(
        await searchFor({
          text: deleteText,
          agentId: memberScope.storageAgentId,
          scope: memberScope.conversationScope,
        }),
        memberId,
      )
    ) {
      reopenFailures += 1;
    }

    const secretCanaryMatches = JSON.stringify({
      facts,
      queries,
      principals: principals.length,
      authorizedRecallFailures,
      crossPrincipalViolations,
      crossConversationViolations,
      principalFactFailures,
      deletionFailures,
      reopenFailures,
      ledgerIntegrity,
      ledgerStats,
      reopenStats,
      indexStats,
    }).includes(secretCanary)
      ? 1
      : 0;
    const report: MemoryIsolationCertificationReport = {
      status:
        authorizedRecallFailures === 0 &&
        crossPrincipalViolations === 0 &&
        crossConversationViolations === 0 &&
        principalFactFailures === 0 &&
        deletionFailures === 0 &&
        reopenFailures === 0 &&
        secretCanaryMatches === 0 &&
        ledgerIntegrity.ok &&
        ledgerStats.events === facts &&
        reopenStats.events === facts &&
        indexStats.rows === facts + principalRows.length - 1
          ? "PASS"
          : "FAIL",
      facts,
      queries,
      principals: principals.length,
      conversationsPerPrincipal: conversationIds.length,
      authorizedRecallFailures,
      crossPrincipalViolations,
      crossConversationViolations,
      principalFactFailures,
      deletionFailures,
      reopenFailures,
      secretCanaryMatches,
      ledgerIntegrity,
      ledgerStats,
      reopenStats,
      indexStats,
      queryLatencyMs: {
        median: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: Math.max(...latencies),
      },
      directory,
    };
    index.close();
    if (ephemeral && !options.keep) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    return report;
  } catch (error) {
    index.close();
    ledger.close();
    if (ephemeral && !options.keep) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
