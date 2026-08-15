import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FunctionalFinnMemoryLedger, type FunctionalFinnMemoryRecord } from "./memory-ledger.js";
import {
  FunctionalFinnMemoryProjector,
  materializeFunctionalFinnMemory,
  type FunctionalFinnMaterializerFileSystem,
  type FunctionalFinnMemoryProjectionState,
} from "./memory-materializer.js";
import { resolveFunctionalFinnProjectionPaths } from "./memory-projection-path.js";
import { FunctionalFinnMemoryProjectionService } from "./memory-projection-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

function atomicStore<T>(values: Map<string, T>) {
  return {
    update(key: string, mutate: (current: T | undefined) => T | undefined) {
      const next = mutate(values.get(key));
      if (next === undefined) {
        values.delete(key);
      } else {
        values.set(key, structuredClone(next));
      }
      return true;
    },
    lookup: (key: string) => values.get(key),
    entries: () => [...values].map(([key, value]) => ({ key, value })),
  };
}

async function workspace(name: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `functional-finn-${name}-`));
  directories.push(directory);
  return directory;
}

function admit(
  ledger: FunctionalFinnMemoryLedger,
  params: {
    factKey: string;
    claim?: string;
    evidenceId: string;
    observedAt: number;
    freshnessUntil?: number;
    agentId?: string;
    tombstone?: boolean;
  },
) {
  return ledger.admit({
    agentId: params.agentId ?? "finn",
    factKey: params.factKey,
    claim: params.claim,
    sourceKind: "tool_observation",
    evidenceId: params.evidenceId,
    observedAt: params.observedAt,
    freshnessUntil: params.freshnessUntil ?? 10_000,
    confidence: 1,
    authority: 80,
    tombstone: params.tombstone,
  }).record;
}

function projectionFixture(params: {
  memory?: Map<string, FunctionalFinnMemoryRecord>;
  states?: Map<string, FunctionalFinnMemoryProjectionState>;
  workspaces: Record<string, string>;
  now: () => number;
  materialize?: typeof materializeFunctionalFinnMemory;
}) {
  const memory = params.memory ?? new Map<string, FunctionalFinnMemoryRecord>();
  const states = params.states ?? new Map<string, FunctionalFinnMemoryProjectionState>();
  const ledger = new FunctionalFinnMemoryLedger(atomicStore(memory));
  const projector = new FunctionalFinnMemoryProjector(
    ledger,
    atomicStore(states),
    (agentId) =>
      resolveFunctionalFinnProjectionPaths({
        agentId,
        workspaceDir: params.workspaces[agentId] ?? "",
      }),
    params.now,
    params.materialize,
  );
  return { ledger, memory, projector, states };
}

function projectionPath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "functional-finn-verified.md");
}

function failingMaterializer(operation: "write" | "rename") {
  return (params: Parameters<typeof materializeFunctionalFinnMemory>[0]) => {
    const fileSystem: FunctionalFinnMaterializerFileSystem = {
      chmod: (target, mode) => fs.chmod(target, mode),
      lstat: (target) => fs.lstat(target),
      mkdir: (target, options) => fs.mkdir(target, options),
      readFile: (target, encoding) => fs.readFile(target, encoding),
      rename: (source, target) =>
        operation === "rename"
          ? Promise.reject(new Error("injected rename failure"))
          : fs.rename(source, target),
      rm: (target, options) => fs.rm(target, options),
      rmdir: (target) => fs.rmdir(target),
      writeFile: (target, content, options) =>
        operation === "write"
          ? Promise.reject(new Error("injected write failure"))
          : fs.writeFile(target, content, options),
    };
    return materializeFunctionalFinnMemory({ ...params, fileSystem });
  };
}

describe("Functional Finn memory projection reconciliation", () => {
  it.each(["write", "rename"] as const)(
    "recovers replacement and tombstone after an injected %s failure and restart",
    async (operation) => {
      let now = 100;
      const workspaceDir = await workspace(operation);
      const base = projectionFixture({ workspaces: { finn: workspaceDir }, now: () => now });
      admit(base.ledger, {
        factKey: "service.status",
        claim: "Service is degraded.",
        evidenceId: "old",
        observedAt: 100,
      });
      await base.projector.reconcileAgent("finn");

      now = 200;
      const replacement = admit(base.ledger, {
        factKey: "service.status",
        claim: "Service is healthy.",
        evidenceId: "replacement",
        observedAt: now,
      });
      const failing = projectionFixture({
        memory: base.memory,
        states: base.states,
        workspaces: { finn: workspaceDir },
        now: () => now,
        materialize: failingMaterializer(operation),
      });
      await expect(failing.projector.reconcileAgent("finn")).rejects.toThrow(/injected/);
      expect(failing.ledger.lookup("finn", "service.status")?.remediation.state).toBe("pending");
      expect(base.states.get("finn")).toMatchObject({ state: "pending" });
      expect(
        (await fs.readdir(path.dirname(projectionPath(workspaceDir)))).some((name) =>
          name.endsWith(".tmp"),
        ),
      ).toBe(false);

      const restarted = projectionFixture({
        memory: base.memory,
        states: base.states,
        workspaces: { finn: workspaceDir },
        now: () => now,
      });
      await restarted.projector.reconcileAgent("finn");
      let rendered = await fs.readFile(projectionPath(workspaceDir), "utf8");
      expect(rendered).toContain("Service is healthy.");
      expect(rendered).not.toContain("Service is degraded.");
      expect(restarted.ledger.lookup("finn", "service.status")?.revisionDigest).toBe(
        replacement.revisionDigest,
      );

      now = 300;
      admit(restarted.ledger, {
        factKey: "service.status",
        evidenceId: "tombstone",
        observedAt: now,
        tombstone: true,
      });
      const tombstoneFailure = projectionFixture({
        memory: base.memory,
        states: base.states,
        workspaces: { finn: workspaceDir },
        now: () => now,
        materialize: failingMaterializer(operation),
      });
      await expect(tombstoneFailure.projector.reconcileAgent("finn")).rejects.toThrow(/injected/);
      expect(tombstoneFailure.ledger.recall({ agentId: "finn", now })).toEqual([]);

      const restartedAfterTombstone = projectionFixture({
        memory: base.memory,
        states: base.states,
        workspaces: { finn: workspaceDir },
        now: () => now,
      });
      await restartedAfterTombstone.projector.reconcileAgent("finn");
      rendered = await fs.readFile(projectionPath(workspaceDir), "utf8");
      expect(rendered).not.toContain("Service is healthy.");
      expect(base.states.get("finn")).toMatchObject({ state: "applied" });
    },
  );

  it("projects every one of 75 current facts without a 50-row truncation", async () => {
    const workspaceDir = await workspace("many");
    const fixture = projectionFixture({ workspaces: { finn: workspaceDir }, now: () => 100 });
    for (let index = 0; index < 75; index += 1) {
      admit(fixture.ledger, {
        factKey: `fact.${index.toString().padStart(2, "0")}`,
        claim: `Current fact ${index}.`,
        evidenceId: `evidence-${index}`,
        observedAt: index + 1,
      });
    }
    await fixture.projector.reconcileAgent("finn");
    const rendered = await fs.readFile(projectionPath(workspaceDir), "utf8");
    expect(rendered.match(/^- Current fact/gm)).toHaveLength(75);
    expect(rendered).toContain("Current fact 0.");
    expect(rendered).toContain("Current fact 74.");
    expect((await fs.stat(path.dirname(projectionPath(workspaceDir)))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(projectionPath(workspaceDir))).mode & 0o777).toBe(0o600);
  });

  it("removes expired memory through the owned expiry path without another admission", async () => {
    let now = 100;
    const workspaceDir = await workspace("expiry");
    const fixture = projectionFixture({ workspaces: { finn: workspaceDir }, now: () => now });
    admit(fixture.ledger, {
      factKey: "ephemeral.status",
      claim: "The transient status is active.",
      evidenceId: "ephemeral",
      observedAt: now,
      freshnessUntil: 150,
    });
    const scheduled: Array<() => void> = [];
    const clear = vi.fn();
    const service = new FunctionalFinnMemoryProjectionService(
      fixture.projector,
      ["finn"],
      vi.fn(),
      {
        set: (callback) => {
          scheduled.push(callback);
          return callback;
        },
        clear,
      },
    );
    await service.start();
    expect(await fs.readFile(projectionPath(workspaceDir), "utf8")).toContain("status is active");

    now = 151;
    await service.runExpiryReconciliation();
    const indexSource = await fs.readFile(projectionPath(workspaceDir), "utf8");
    expect(indexSource).not.toContain("status is active");
    expect(fixture.ledger.recall({ agentId: "finn", now })).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await service.stop();
    expect(clear).toHaveBeenCalledWith(scheduled[0]);
  });

  it("repairs durable pending work during service startup", async () => {
    const workspaceDir = await workspace("startup");
    const base = projectionFixture({ workspaces: { finn: workspaceDir }, now: () => 100 });
    admit(base.ledger, {
      factKey: "startup.fact",
      claim: "Startup repaired this fact.",
      evidenceId: "startup",
      observedAt: 100,
    });
    const failed = projectionFixture({
      memory: base.memory,
      states: base.states,
      workspaces: { finn: workspaceDir },
      now: () => 100,
      materialize: failingMaterializer("write"),
    });
    await expect(failed.projector.reconcileAgent("finn")).rejects.toThrow(/injected/);

    const restarted = projectionFixture({
      memory: base.memory,
      states: base.states,
      workspaces: { finn: workspaceDir },
      now: () => 100,
    });
    const service = new FunctionalFinnMemoryProjectionService(
      restarted.projector,
      ["finn"],
      vi.fn(),
      { set: () => 1, clear: vi.fn() },
    );
    await service.start();
    expect(await fs.readFile(projectionPath(workspaceDir), "utf8")).toContain(
      "Startup repaired this fact.",
    );
    expect(base.states.get("finn")).toMatchObject({ state: "applied" });
    await service.stop();
  });

  it("is idempotent across repeated reconciliation and restart", async () => {
    const workspaceDir = await workspace("idempotent");
    let writes = 0;
    const materialize = async (params: Parameters<typeof materializeFunctionalFinnMemory>[0]) => {
      writes += 1;
      return materializeFunctionalFinnMemory(params);
    };
    const base = projectionFixture({
      workspaces: { finn: workspaceDir },
      now: () => 100,
      materialize,
    });
    admit(base.ledger, {
      factKey: "stable.fact",
      claim: "The projection is stable.",
      evidenceId: "stable",
      observedAt: 100,
    });
    const first = await base.projector.reconcileAgent("finn");
    const firstContent = await fs.readFile(projectionPath(workspaceDir), "utf8");
    const repeated = await base.projector.reconcileAgent("finn");
    expect(repeated.attemptId).toBe(first.attemptId);
    expect(writes).toBe(1);

    const restarted = projectionFixture({
      memory: base.memory,
      states: base.states,
      workspaces: { finn: workspaceDir },
      now: () => 100,
      materialize,
    });
    await restarted.projector.reconcileAgent("finn", { force: true });
    expect(await fs.readFile(projectionPath(workspaceDir), "utf8")).toBe(firstContent);
    expect(writes).toBe(2);
  });

  it("migrates an old applied projection instead of accepting split recall state", async () => {
    const workspaceDir = await workspace("applied-migration");
    const fixture = projectionFixture({ workspaces: { finn: workspaceDir }, now: () => 100 });
    const record = admit(fixture.ledger, {
      factKey: "migration.fact",
      claim: "The migrated fact is current.",
      evidenceId: "migration",
      observedAt: 100,
    });
    await fixture.projector.reconcileAgent("finn");
    await fs.rm(projectionPath(workspaceDir));
    const legacy = path.join(workspaceDir, "memory", "verified", "functional-finn.md");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(
      legacy,
      `# Verified memory\n\n- ${record.claim} <!-- functional-finn:${record.revisionDigest}; observedAt=${record.observedAt}; freshnessUntil=${record.freshnessUntil} -->\n`,
      "utf8",
    );

    await fixture.projector.reconcileAgent("finn");
    await expect(fs.readFile(projectionPath(workspaceDir), "utf8")).resolves.toContain(
      "The migrated fact is current.",
    );
    await expect(fs.access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps projections agent-scoped and never resurrects stale evidence", async () => {
    let now = 100;
    const finnWorkspace = await workspace("finn");
    const otherWorkspace = await workspace("other");
    const fixture = projectionFixture({
      workspaces: { finn: finnWorkspace, other: otherWorkspace },
      now: () => now,
    });
    admit(fixture.ledger, {
      factKey: "shared.key",
      claim: "Finn sees alpha.",
      evidenceId: "finn-alpha",
      observedAt: now,
    });
    admit(fixture.ledger, {
      agentId: "other",
      factKey: "shared.key",
      claim: "Other sees omega.",
      evidenceId: "other-omega",
      observedAt: now,
    });
    await fixture.projector.reconcileAgent("finn");
    await fixture.projector.reconcileAgent("other");
    expect(await fs.readFile(projectionPath(finnWorkspace), "utf8")).not.toContain("omega");
    expect(await fs.readFile(projectionPath(otherWorkspace), "utf8")).not.toContain("alpha");

    now = 200;
    admit(fixture.ledger, {
      factKey: "shared.key",
      claim: "Finn sees beta.",
      evidenceId: "finn-beta",
      observedAt: now,
    });
    expect(() =>
      admit(fixture.ledger, {
        factKey: "shared.key",
        claim: "Finn sees alpha.",
        evidenceId: "stale-alpha",
        observedAt: 150,
      }),
    ).toThrow(/not newer/);
    await fixture.projector.reconcileAgent("finn");
    const rendered = await fs.readFile(projectionPath(finnWorkspace), "utf8");
    expect(rendered).toContain("Finn sees beta.");
    expect(rendered).not.toContain("Finn sees alpha.");
  });
});
