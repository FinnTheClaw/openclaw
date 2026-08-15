import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostGovernorBroker } from "../../security/governor-host-broker.js";
import { createGovernorHostPersistence } from "../../security/governor-host-persistence.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "../../security/governor-host-secrets.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GovernorController } from "./controller.js";
import { governorMemoryAuthorityBinding } from "./memory-authority.js";
import { governorMemoryFactPredicate } from "./memory-contradiction-policy.js";
import {
  correctMemoryTestTask,
  memoryScopeA,
  memoryTestRegistry,
  persistMemoryEvidence,
  seedMemoryFact,
  startMemoryTestTask,
  withMemoryTestHarness,
} from "./memory-contradiction-test-helpers.js";
import { GovernorSqliteStore } from "./store.js";
import { createGovernorTestStore } from "./test-broker.js";

afterEach(() => closeOpenClawStateDatabase());

describe("governor memory anti-rollback authority", () => {
  it("keeps an obsolete plan fact inactive after restoring the pre-correction primary", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-pre-correction-path",
        factKey: "fixture.path",
        path: "/fixture/obsolete",
        observedAt: 100,
      });
      closeOpenClawStateDatabase();
      const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
      const snapshotPath = path.join(stateDir, "primary-before-task-correction.sqlite");
      fs.copyFileSync(databasePath, snapshotPath);

      expect(correctMemoryTestTask(controller, memoryScopeA, 2)).toBe(taskId);
      expect(store.memory.retrieve({ scope: memoryScopeA, now: 210 })).toEqual([]);

      closeOpenClawStateDatabase();
      fs.copyFileSync(snapshotPath, databasePath);
      for (const suffix of ["-wal", "-shm"]) {
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }

      const restarted = createGovernorTestStore({
        stateDir,
        capabilities: memoryTestRegistry(),
      });
      expect(restarted.store.loadTask(taskId)).toBeNull();
      expect(
        Array.from({ length: 100 }, () =>
          restarted.store.memory.retrieve({ scope: memoryScopeA, now: 300 }),
        ).every((items) => items.length === 0),
      ).toBe(true);
      expect(restarted.store.memory.listReobservationRequirements(memoryScopeA)).toMatchObject([
        { status: "required", staleMemoryId: "memory-pre-correction-path" },
      ]);
      expect(
        restarted.store.memory.promoteVerified({
          taskId,
          evidenceId: "seed-evidence-memory-pre-correction-path",
          memoryId: "memory-replayed-old-plan",
          factKey: "fixture.path",
          scope: memoryScopeA,
          expectedScopeEpoch: 0,
          now: 301,
        }),
      ).toMatchObject({ stored: false, reason: "provenance_rejected" });
      expect(restarted.store.memory.listReobservationRequirements(memoryScopeA)).toHaveLength(1);
    });
  });

  it("never restores a disproven fact after replaying an older primary database", async () => {
    await withMemoryTestHarness(async ({ store, broker, controller, stateDir }) => {
      const taskId = startMemoryTestTask(controller, memoryScopeA);
      seedMemoryFact({
        store,
        broker,
        taskId,
        scope: memoryScopeA,
        memoryId: "memory-stale-path",
        factKey: "ssh.path",
        path: "/stale/path",
        observedAt: 100,
        sourceKind: "structured_external",
      });
      closeOpenClawStateDatabase();
      const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
      const snapshotPath = path.join(stateDir, "primary-before-memory-repair.sqlite");
      fs.copyFileSync(databasePath, snapshotPath);

      persistMemoryEvidence({
        store,
        broker,
        taskId,
        evidenceId: "evidence-current-path",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/current/path" },
        observedAt: 200,
      });
      expect(
        store.memory.resolveContradiction({
          taskId,
          evidenceId: "evidence-current-path",
          staleMemoryId: "memory-stale-path",
          contradictionClass: "stale canonical source",
          executionFence: controller.captureExecutionFence(taskId),
          now: 201,
        }).kind,
      ).toBe("retired");
      expect(
        store.memory.activeReplacement({ scope: memoryScopeA, factKey: "ssh.path", now: 202 }),
      ).toMatchObject({ content: { path: "/current/path" } });
      const retiredAudit = store.memory
        .retrieveAudit({ scope: memoryScopeA })
        .find((memory) => memory.memoryId === "memory-stale-path");
      if (!retiredAudit) {
        throw new Error("missing retired memory audit record");
      }
      expect(() =>
        broker.memoryAuthority.retire(
          governorMemoryAuthorityBinding({ ...retiredAudit, status: "verified" }),
        ),
      ).toThrow(/does not match current host authority/u);

      closeOpenClawStateDatabase();
      fs.copyFileSync(snapshotPath, databasePath);
      for (const suffix of ["-wal", "-shm"]) {
        fs.rmSync(`${databasePath}${suffix}`, { force: true });
      }

      const restartedCapabilities = memoryTestRegistry();
      const restarted = createGovernorTestStore({
        stateDir,
        capabilities: restartedCapabilities,
      });
      expect(restarted.store.memory.retrieve({ scope: memoryScopeA, now: 300 })).toEqual([]);
      expect(
        Array.from({ length: 100 }, () =>
          restarted.store.memory.retrieve({ scope: memoryScopeA, now: 301 }),
        ).every((items) => items.length === 0),
      ).toBe(true);
      expect(restarted.store.memory.listReobservationRequirements(memoryScopeA)).toMatchObject([
        { status: "required", staleMemoryId: "memory-stale-path" },
      ]);

      const replayed = restarted.store.memory.promoteVerified({
        taskId,
        evidenceId: "seed-evidence-memory-stale-path",
        memoryId: "memory-replayed-stale-path",
        factKey: "ssh.path",
        scope: memoryScopeA,
        expectedScopeEpoch: 0,
        now: 301,
      });
      expect(replayed).toMatchObject({ stored: false, reason: "provenance_rejected" });
      expect(
        restarted.store.memory.activeReplacement({
          scope: memoryScopeA,
          factKey: "ssh.path",
          now: 301,
        }),
      ).toBeNull();
      expect(restarted.store.memory.listReobservationRequirements(memoryScopeA)).toMatchObject([
        { status: "required", staleMemoryId: "memory-stale-path" },
      ]);

      const recoveryController = new GovernorController(restarted.store, restartedCapabilities);
      const recoveredTaskId = startMemoryTestTask(recoveryController, memoryScopeA, 2);
      expect(recoveredTaskId).toBe(taskId);

      persistMemoryEvidence({
        store: restarted.store,
        broker: restarted.broker,
        taskId: recoveredTaskId,
        evidenceId: "evidence-reobserved-path",
        criterionId: "memory-observed",
        predicate: governorMemoryFactPredicate("ssh.path"),
        value: { path: "/current/path" },
        observedAt: 302,
      });
      expect(
        restarted.store.memory.promoteVerified({
          taskId: recoveredTaskId,
          evidenceId: "evidence-reobserved-path",
          memoryId: "memory-reobserved-path",
          factKey: "ssh.path",
          scope: memoryScopeA,
          expectedScopeEpoch: 0,
          now: 303,
        }),
      ).toMatchObject({ stored: true });
      expect(
        restarted.store.memory.activeReplacement({
          scope: memoryScopeA,
          factKey: "ssh.path",
          now: 304,
        }),
      ).toMatchObject({ content: { path: "/current/path" } });
      expect(restarted.store.memory.listReobservationRequirements(memoryScopeA)).toMatchObject([
        { status: "resolved" },
      ]);
    });
  });

  it("keeps explicit forget fenced when primary rollback follows host retirement", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-memory-forget-crash-" },
      async (state) => {
        let crashAfterAppend = false;
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            if (crashAfterAppend) {
              crashAfterAppend = false;
              throw new Error("synthetic forget crash after ledger append");
            }
          },
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const capabilities = memoryTestRegistry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          memoryAuthority: broker.memoryAuthority,
          secrets,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
        const taskId = startMemoryTestTask(controller, memoryScopeA);
        seedMemoryFact({
          store,
          broker: { ...broker, secrets },
          taskId,
          scope: memoryScopeA,
          memoryId: "memory-explicit-forget",
          factKey: "ssh.path",
          path: "/must-stay-forgotten",
          observedAt: 100,
        });

        crashAfterAppend = true;
        expect(() =>
          store.memory.forget({
            memoryId: "memory-explicit-forget",
            scope: memoryScopeA,
            expectedScopeEpoch: 0,
            now: 201,
          }),
        ).toThrow(/synthetic forget crash/u);

        closeOpenClawStateDatabase();
        const restartedPersistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
        });
        const restartedBroker = createHostGovernorBroker({
          secrets,
          persistence: restartedPersistence,
        });
        const restarted = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: restartedBroker.resolver,
          approvalResolver: restartedBroker.approvalResolver,
          deliveryResolver: restartedBroker.deliveryResolver,
          physicalExecutionCoordinator: restartedBroker.physicalExecutionCoordinator,
          memoryAuthority: restartedBroker.memoryAuthority,
          secrets,
          capabilities,
        });
        const forgottenAudit = restarted.memory
          .retrieveAudit({ scope: memoryScopeA })
          .find((memory) => memory.memoryId === "memory-explicit-forget");
        if (!forgottenAudit) {
          throw new Error("missing explicit-forget audit record");
        }
        expect(
          restartedBroker.memoryAuthority.state(forgottenAudit.scopeKey, forgottenAudit.factKey),
        ).toMatchObject({ status: "retired", retirementReason: "explicit_forget" });
        expect(
          restarted.memory.promoteVerified({
            taskId,
            evidenceId: "seed-evidence-memory-explicit-forget",
            memoryId: "memory-explicit-forget",
            factKey: "ssh.path",
            scope: memoryScopeA,
            expectedScopeEpoch: 0,
            now: 300,
          }),
        ).toMatchObject({ stored: false, reason: "provenance_rejected" });
        expect(restarted.memory.retrieve({ scope: memoryScopeA, now: 301 })).toEqual([]);
      },
    );
  });

  it("reconciles a host-ledger append followed by primary transaction rollback", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-governor-memory-ledger-crash-" },
      async (state) => {
        let crashAfterAppend = false;
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            if (crashAfterAppend) {
              crashAfterAppend = false;
              throw new Error("synthetic memory crash after ledger append");
            }
          },
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const testBroker = { ...broker, secrets };
        const capabilities = memoryTestRegistry();
        const store = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: broker.resolver,
          approvalResolver: broker.approvalResolver,
          deliveryResolver: broker.deliveryResolver,
          physicalExecutionCoordinator: broker.physicalExecutionCoordinator,
          memoryAuthority: broker.memoryAuthority,
          secrets,
          capabilities,
        });
        const controller = new GovernorController(store, capabilities);
        const taskId = startMemoryTestTask(controller, memoryScopeA);
        seedMemoryFact({
          store,
          broker: testBroker,
          taskId,
          scope: memoryScopeA,
          memoryId: "memory-before-crash",
          factKey: "ssh.path",
          path: "/stale/path",
          observedAt: 100,
        });
        persistMemoryEvidence({
          store,
          broker: testBroker,
          taskId,
          evidenceId: "evidence-before-memory-crash",
          criterionId: "memory-observed",
          predicate: governorMemoryFactPredicate("ssh.path"),
          value: { path: "/current/path" },
          observedAt: 200,
        });

        crashAfterAppend = true;
        expect(() =>
          store.memory.resolveContradiction({
            taskId,
            evidenceId: "evidence-before-memory-crash",
            staleMemoryId: "memory-before-crash",
            contradictionClass: "stale canonical source",
            executionFence: controller.captureExecutionFence(taskId),
            now: 201,
          }),
        ).toThrow(/synthetic memory crash/u);

        closeOpenClawStateDatabase();
        const restartedPersistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
        });
        const restartedBroker = createHostGovernorBroker({
          secrets,
          persistence: restartedPersistence,
        });
        const restarted = new GovernorSqliteStore({
          stateDir: state.stateDir,
          receiptResolver: restartedBroker.resolver,
          approvalResolver: restartedBroker.approvalResolver,
          deliveryResolver: restartedBroker.deliveryResolver,
          physicalExecutionCoordinator: restartedBroker.physicalExecutionCoordinator,
          memoryAuthority: restartedBroker.memoryAuthority,
          secrets,
          capabilities,
        });
        expect(restarted.memory.retrieve({ scope: memoryScopeA, now: 300 })).toEqual([]);
        expect(restarted.memory.listReobservationRequirements(memoryScopeA)).toMatchObject([
          { status: "required", staleMemoryId: "memory-before-crash" },
        ]);
      },
    );
  });
});
