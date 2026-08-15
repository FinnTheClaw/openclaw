import fs from "node:fs/promises";
import path from "node:path";
import type { FunctionalFinnMemoryRecord } from "./memory-ledger.js";

const materializationQueues = new Map<string, Promise<void>>();

export function renderFunctionalFinnMemory(records: FunctionalFinnMemoryRecord[]): string {
  const rows = records
    .filter((record) => record.state === "verified_current" && record.claim)
    .toSorted((a, b) => a.factKey.localeCompare(b.factKey))
    .map(
      (record) =>
        `- ${record.claim} <!-- functional-finn:${record.revisionDigest}; observedAt=${record.observedAt}; freshnessUntil=${record.freshnessUntil} -->`,
    );
  return ["# Verified memory", "", ...rows, ""].join("\n");
}

export async function materializeFunctionalFinnMemory(params: {
  workspaceDir: string;
  loadRecords: () => FunctionalFinnMemoryRecord[];
}): Promise<string> {
  const directory = path.join(params.workspaceDir, "memory", "verified");
  const target = path.join(directory, "functional-finn.md");
  const previous = materializationQueues.get(target) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, renderFunctionalFinnMemory(params.loadRecords()), {
        mode: 0o600,
      });
      await fs.rename(temporary, target);
    });
  materializationQueues.set(target, current);
  try {
    await current;
  } finally {
    if (materializationQueues.get(target) === current) {
      materializationQueues.delete(target);
    }
  }
  return target;
}
