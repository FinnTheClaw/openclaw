import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { HybridMemoryIndex, type MemoryProjectionInput } from "../hybrid-memory-index.js";
import { TemporalMemoryLedger } from "../temporal-ledger.js";

type Options = {
  facts: number;
  queries: number;
  directory?: string;
  output?: string;
  keep: boolean;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const read = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const facts = Number(read("--facts") ?? 25_000);
  const queries = Number(read("--queries") ?? 200);
  if (!Number.isInteger(facts) || facts < 1_000 || facts > 2_000_000) {
    throw new Error("--facts must be an integer between 1000 and 2000000");
  }
  if (!Number.isInteger(queries) || queries < 1 || queries > 10_000) {
    throw new Error("--queries must be an integer between 1 and 10000");
  }
  return {
    facts,
    queries,
    directory: read("--directory"),
    output: read("--output"),
    keep: args.includes("--keep"),
  };
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

async function main() {
  const options = parseOptions();
  const directory = options.directory
    ? path.resolve(options.directory)
    : await fs.mkdtemp(path.join(os.tmpdir(), "memory-v2-scale-cert-"));
  await fs.mkdir(directory, { recursive: true });
  const ledgerPath = path.join(directory, "ledger.sqlite3");
  const projectionPath = path.join(directory, "lance");
  const ledger = new TemporalMemoryLedger(ledgerPath);
  const index = new HybridMemoryIndex(projectionPath, 64);
  const ingestStarted = performance.now();
  for (let start = 0; start < options.facts; start += 10_000) {
    const count = Math.min(10_000, options.facts - start);
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
  for (let start = 0; start < options.facts; start += 10_000) {
    const count = Math.min(10_000, options.facts - start);
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
    return seed % options.facts;
  };
  const latencies: number[] = [];
  const failures: Array<{ expected: string; actual?: string }> = [];
  for (let queryIndex = 0; queryIndex < options.queries; queryIndex++) {
    const target = nextIndex();
    const token = `ZX-${target.toString(36).toUpperCase().padStart(8, "0")}-MEMORY`;
    const query = `Which asset uses verification token ${token}?`;
    const started = performance.now();
    const results = await index.search({
      agentId: "jake",
      queryText: query,
      vector: vector(factText(target)),
      validAt: 1_800_000_000_000,
      limit: 5,
    });
    latencies.push(performance.now() - started);
    if (results[0]?.entry.id !== `fact-${target}` || results.length > 5) {
      failures.push({ expected: `fact-${target}`, actual: results[0]?.entry.id });
    }
  }

  const integrity = ledger.verifyIntegrity();
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

  const report = {
    status:
      failures.length === 0 &&
      integrity.ok &&
      fullyIndexed &&
      indexStats.rows === options.facts &&
      ledgerStats.events === options.facts &&
      reopenStats.events === options.facts
        ? "PASS"
        : "FAIL",
    facts: options.facts,
    queries: options.queries,
    recallFailures: failures.slice(0, 20),
    recallAt1: (options.queries - failures.length) / options.queries,
    queryLatencyMs: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: Math.max(...latencies),
    },
    ingestMs,
    indexMs,
    ledgerIntegrity: integrity,
    ledgerStats,
    reopenStats,
    indexStats,
    fullyIndexed,
    bytesOnDisk: await directoryBytes(directory),
    directory,
    snapshotPath,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await fs.writeFile(path.resolve(options.output), serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (!options.keep && !options.directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  if (report.status !== "PASS") {
    process.exitCode = 1;
  }
}

await main();
