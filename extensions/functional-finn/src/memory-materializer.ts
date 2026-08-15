import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FunctionalFinnMemoryLedger, FunctionalFinnMemoryRecord } from "./memory-ledger.js";

const RECONCILE_INTERVAL_MS = 60_000;
const MAX_RECONCILE_PASSES = 4;

export type FunctionalFinnMemoryProjectionState = {
  schemaVersion: 1;
  agentId: string;
  attemptId: string;
  state: "pending" | "applied";
  attempts: number;
  attemptedAt: number;
  appliedAt?: number;
};

export type FunctionalFinnProjectionStateStore = {
  update: (
    key: string,
    mutate: (
      current: FunctionalFinnMemoryProjectionState | undefined,
    ) => FunctionalFinnMemoryProjectionState,
  ) => boolean;
  lookup: (key: string) => FunctionalFinnMemoryProjectionState | undefined;
};

export type FunctionalFinnMaterializerFileSystem = {
  chmod: (target: string, mode: number) => Promise<unknown>;
  mkdir: (target: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  rename: (source: string, target: string) => Promise<unknown>;
  rm: (target: string, options: { force: true }) => Promise<unknown>;
  writeFile: (
    target: string,
    content: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ) => Promise<unknown>;
};

type IntervalScheduler = {
  set: (callback: () => void, intervalMs: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultScheduler: IntervalScheduler = {
  set(callback, intervalMs) {
    const handle = setInterval(callback, intervalMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

const materializationQueues = new Map<string, Promise<void>>();

export function renderFunctionalFinnMemory(
  records: FunctionalFinnMemoryRecord[],
  agentId: string,
): string {
  if (records.some((record) => record.agentId !== agentId)) {
    throw new Error("cross-agent memory projection refused");
  }
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
  agentId: string;
  records: FunctionalFinnMemoryRecord[];
  attemptId: string;
  fileSystem?: FunctionalFinnMaterializerFileSystem;
}): Promise<string> {
  const fileSystem = params.fileSystem ?? fs;
  const directory = path.join(params.workspaceDir, "memory", "verified");
  const target = path.join(directory, "functional-finn.md");
  const previous = materializationQueues.get(target) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${target}.${process.pid}.${params.attemptId.slice(0, 16)}.${randomUUID()}.tmp`;
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      await fileSystem.chmod(directory, 0o700);
      try {
        await fileSystem.writeFile(
          temporary,
          renderFunctionalFinnMemory(params.records, params.agentId),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await fileSystem.rename(temporary, target);
        await fileSystem.chmod(target, 0o600);
      } finally {
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
      }
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

function snapshot(params: { agentId: string; ledger: FunctionalFinnMemoryLedger; now: number }): {
  attemptId: string;
  all: FunctionalFinnMemoryRecord[];
  eligible: FunctionalFinnMemoryRecord[];
} {
  const all = params.ledger.recordsForAgent(params.agentId);
  const eligible = params.ledger.projectionRecords(params.agentId, params.now);
  const eligibleDigests = new Set(eligible.map((record) => record.revisionDigest));
  const attemptId = createHash("sha256")
    .update(
      JSON.stringify({
        agentId: params.agentId,
        records: all.map((record) => [
          record.revisionDigest,
          eligibleDigests.has(record.revisionDigest),
        ]),
      }),
    )
    .digest("hex");
  return { attemptId, all, eligible };
}

export class FunctionalFinnMemoryProjector {
  private readonly queues = new Map<string, Promise<FunctionalFinnMemoryProjectionState>>();

  constructor(
    private readonly ledger: FunctionalFinnMemoryLedger,
    private readonly states: FunctionalFinnProjectionStateStore,
    private readonly workspaceForAgent: (agentId: string) => string,
    private readonly now: () => number = Date.now,
    private readonly materialize: typeof materializeFunctionalFinnMemory = materializeFunctionalFinnMemory,
  ) {}

  reconcileAgent(
    agentId: string,
    options?: { force?: boolean },
  ): Promise<FunctionalFinnMemoryProjectionState> {
    const previous = this.queues.get(agentId) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(() => this.reconcile(agentId, options?.force ?? false));
    this.queues.set(agentId, current);
    return current.finally(() => {
      if (this.queues.get(agentId) === current) {
        this.queues.delete(agentId);
      }
    });
  }

  private async reconcile(
    agentId: string,
    force: boolean,
  ): Promise<FunctionalFinnMemoryProjectionState> {
    const workspaceDir = this.workspaceForAgent(agentId);
    let mustWrite = force;
    for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass += 1) {
      const attemptedAt = this.now();
      const currentSnapshot = snapshot({ agentId, ledger: this.ledger, now: attemptedAt });
      const prior = this.states.lookup(agentId);
      const hasPending = currentSnapshot.all.some(
        (record) => record.remediation.state === "pending",
      );
      if (
        !mustWrite &&
        !hasPending &&
        prior?.state === "applied" &&
        prior.attemptId === currentSnapshot.attemptId
      ) {
        return prior;
      }
      const pending: FunctionalFinnMemoryProjectionState = {
        schemaVersion: 1,
        agentId,
        attemptId: currentSnapshot.attemptId,
        state: "pending",
        attempts:
          prior?.attemptId === currentSnapshot.attemptId
            ? Math.min(Number.MAX_SAFE_INTEGER, prior.attempts + 1)
            : 1,
        attemptedAt,
      };
      if (!this.states.update(agentId, () => pending)) {
        throw new Error("memory projection remediation did not persist");
      }
      await this.materialize({
        workspaceDir,
        agentId,
        records: currentSnapshot.eligible,
        attemptId: currentSnapshot.attemptId,
      });

      const afterWrite = snapshot({ agentId, ledger: this.ledger, now: this.now() });
      if (afterWrite.attemptId !== currentSnapshot.attemptId) {
        mustWrite = true;
        continue;
      }
      for (const record of currentSnapshot.all) {
        if (
          !this.ledger.markRemediated({
            agentId,
            factKey: record.factKey,
            revisionDigest: record.revisionDigest,
            attemptId: currentSnapshot.attemptId,
          })
        ) {
          throw new Error("memory record remediation did not persist");
        }
      }
      const applied: FunctionalFinnMemoryProjectionState = {
        ...pending,
        state: "applied",
        appliedAt: this.now(),
      };
      if (
        !this.states.update(agentId, (stored) => {
          if (stored?.attemptId !== currentSnapshot.attemptId || stored.state !== "pending") {
            throw new Error("stale projection remediation receipt");
          }
          return applied;
        })
      ) {
        throw new Error("memory projection receipt did not persist");
      }
      return applied;
    }
    throw new Error("memory projection changed during every bounded reconciliation pass");
  }
}

export class FunctionalFinnMemoryProjectionService {
  private timer: unknown;
  private queued = Promise.resolve();

  constructor(
    private readonly projector: FunctionalFinnMemoryProjector,
    private readonly agentIds: readonly string[],
    private readonly onError: (agentId: string, error: unknown) => void,
    private readonly scheduler: IntervalScheduler = defaultScheduler,
    private readonly intervalMs = RECONCILE_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) {
      return;
    }
    await this.run(true);
    this.timer = this.scheduler.set(() => void this.run(false), this.intervalMs);
  }

  runExpiryReconciliation(): Promise<void> {
    return this.run(false);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.scheduler.clear(this.timer);
      this.timer = undefined;
    }
    await this.queued;
  }

  private run(force: boolean): Promise<void> {
    const next = this.queued
      .catch(() => undefined)
      .then(async () => {
        for (const agentId of this.agentIds) {
          try {
            await this.projector.reconcileAgent(agentId, { force });
          } catch (error) {
            this.onError(agentId, error);
          }
        }
      });
    this.queued = next;
    return next;
  }
}
