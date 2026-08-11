import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import { createGovernorEventRecord } from "./events.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  memoryScopeA,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { GovernorResourceGuardError } from "./resource-guard.js";
import { GovernorSecretRejectedError } from "./secret-filter.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor V22 durable persistence boundary", () => {
  it("rejects oversized, cyclic, and secret audit payloads before any write", async () => {
    await withMemoryTestHarness(async ({ store, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const task = store.loadTask(taskId)!;
      const initialCount = store.listEvents(taskId).length;
      const payload = { note: "x".repeat(2 * 1024 * 1024) };
      const oversized = {
        ...createGovernorEventRecord({
          task,
          eventType: "checkpoint_recorded",
          payload: { note: "bounded" },
          now: 100,
        }),
        payload,
        payloadDigest: governorDigest(payload),
      };
      expect(() => store.appendAuditEvent({ task, event: oversized })).toThrow(
        GovernorResourceGuardError,
      );

      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      expect(() =>
        store.appendAuditEvent({
          task,
          event: {
            ...oversized,
            payload: cyclic as GovernorJsonValue,
            payloadDigest: "0".repeat(64),
          },
        }),
      ).toThrow(GovernorResourceGuardError);
      const secretPayload = { accessToken: "synthetic-secret-marker" };
      expect(() =>
        store.appendAuditEvent({
          task,
          event: {
            ...oversized,
            payload: secretPayload,
            payloadDigest: governorDigest(secretPayload),
          },
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.listEvents(taskId)).toHaveLength(initialCount);
    });
  });

  it("guards remediation and manual-review inputs before lookup or mutation", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-v22-guard",
        factKey: "fixture.endpoint",
        path: "/fixture/old",
        observedAt: 100,
      });
      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-v22-guard",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("fixture.endpoint"),
        value: { path: "/fixture/current" },
        observedAt: 200,
      });
      const resolution = store.memory.resolveContradiction({
        taskId,
        evidenceId: "evidence-v22-guard",
        staleMemoryId: "memory-v22-guard",
        contradictionClass: "stale fixture source",
        now: 201,
      });
      if (resolution.kind !== "retired") {
        throw new Error("expected resolved V22 fixture contradiction");
      }
      const fingerprint = resolution.remediation.contradictionFingerprint;
      expect(() =>
        store.memory.updateRepairState({
          fingerprint,
          status: "blocked",
          blockedReason: "x".repeat(2 * 1024 * 1024),
          now: 202,
        }),
      ).toThrow(GovernorResourceGuardError);
      expect(() =>
        store.memory.updateRepairState({
          fingerprint,
          status: "blocked",
          blockedReason: "GOVERNOR_SECRET_CANARY_V22_REPAIR",
          now: 202,
        }),
      ).toThrow(GovernorSecretRejectedError);
      expect(store.memory.loadRemediation(fingerprint)?.status).toBe("queued");
      expect(() =>
        store.outbox.markManualReview({
          taskId: "x".repeat(2 * 1024 * 1024) as never,
          effectId: "missing-effect",
          expectedLeaseEpoch: 0,
          expectedDeliveryClaimEpoch: 0,
          reasonDigest: "0".repeat(64),
          now: 203,
        }),
      ).toThrow(GovernorResourceGuardError);
    });
  });

  it("rejects raw scope identity at direct commit and leaves no partial write", async () => {
    await withMemoryTestHarness(async ({ store, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const task = store.loadTask(taskId)!;
      const rawMarker = "raw-account-fixture-v22";
      const next = {
        ...task,
        scope: { ...task.scope, accountId: rawMarker },
        taskVersion: task.taskVersion + 1,
        updatedAt: 300,
      };
      const event = createGovernorEventRecord({
        task: next,
        eventType: "checkpoint_recorded",
        payload: { checkpoint: "v22" },
        now: 300,
      });
      expect(() => store.commit({ current: task, next, event })).toThrow(/scope identity/u);
      expect(store.loadTask(taskId)).toEqual(task);
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      expect(
        JSON.stringify(db.prepare("SELECT projection_json FROM governor_tasks").all()),
      ).not.toContain(rawMarker);
    });
  });

  it("does not echo corrupt persisted JSON or its secret-shaped key path", async () => {
    await withMemoryTestHarness(async ({ store, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      const marker = "GOVERNOR_SECRET_CANARY_V22_CORRUPT_ROW";
      const rawPath = "nested.accessToken";
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
      db.prepare("UPDATE governor_tasks SET projection_json = ? WHERE task_id = ?").run(
        `{"${rawPath}":"${marker}"`,
        taskId,
      );
      try {
        store.loadTask(taskId);
        throw new Error("expected persisted JSON rejection");
      } catch (error) {
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(rawPath);
      }
    });
  });
});

describe("governor persistence guard inventory", () => {
  it("requires every transactional writer and durable JSON binder to name a guard", () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const securityDirectory = path.resolve(directory, "../../security");
    const sourceFiles = [directory, securityDirectory].flatMap((sourceDirectory) =>
      fs
        .readdirSync(sourceDirectory)
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map(
          (name) =>
            [
              path.relative(directory, path.join(sourceDirectory, name)),
              fs.readFileSync(path.join(sourceDirectory, name), "utf8"),
            ] as const,
        ),
    );
    const writers = sourceFiles.filter(([, source]) =>
      source.includes("runOpenClawStateWriteTransaction"),
    );
    expect(writers.length).toBeGreaterThan(10);
    for (const [name, source] of writers) {
      expect
        .soft(source, name)
        .toMatch(/assertGovernor(?:JsonResources|PersistedJson|BoundarySafe)/u);
    }
    expect(
      fs.readFileSync(
        path.join(securityDirectory, "governor-host-anti-rollback-ledger.ts"),
        "utf8",
      ),
    ).toContain("assertGovernorBoundarySafe");
    for (const name of [
      "action-intent-codec.ts",
      "checkpoint-store.ts",
      "fanout-codec.ts",
      "memory-record-codec.ts",
      "memory-remediation.ts",
      "outbox-codec.ts",
      "outbox-store.ts",
      "store-codec.ts",
    ]) {
      expect(fs.readFileSync(path.join(directory, name), "utf8"), name).toContain(
        "assertGovernorPersistedJson",
      );
    }
  });
});
