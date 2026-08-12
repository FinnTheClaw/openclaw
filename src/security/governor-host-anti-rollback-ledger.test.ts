import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGovernorHostAntiRollbackLedger } from "./governor-host-anti-rollback-ledger.js";
import { createHostGovernorBroker } from "./governor-host-broker.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "./governor-host-secrets.js";

const ledgerKey = "synthetic-v9-ledger-key";
const receiptKey = "synthetic-v9-receipt-key";

function ledgerPaths(stateDir: string): { journal: string; head: string } {
  const directory = path.join(stateDir, "state", "host-governor");
  return {
    journal: path.join(directory, "anti-rollback-v1.journal"),
    head: path.join(directory, "anti-rollback-v1.head"),
  };
}

function register(broker: ReturnType<typeof createHostGovernorBroker>, generation = 0) {
  return broker.capabilities.registerStaticDeliveryAdapter({
    implementationId: "synthetic",
    config: { fixture: "v9" },
    generation,
  });
}

afterEach(() => closeOpenClawStateDatabase());

describe("governor V9 host anti-rollback ledger", () => {
  it("seals current high-water state and rejects same-generation binding changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-v9-ledger-"));
    try {
      const first = createGovernorHostAntiRollbackLedger({
        stateDir: root,
        signingKey: ledgerKey,
        allowInitialization: true,
      });
      first.append({
        kind: "delivery",
        key: "opaque-adapter",
        generation: 0,
        status: "certified",
        bindingDigest: "a",
      });
      expect(() =>
        first.append({
          kind: "delivery",
          key: "opaque-adapter",
          generation: 0,
          status: "certified",
          bindingDigest: "b",
        }),
      ).toThrow(/GOVERNOR_HOST_LEDGER_BINDING_CONFLICT/u);
      const paths = {
        journal: path.join(root, "host-governor", "anti-rollback-v1.journal"),
        head: path.join(root, "host-governor", "anti-rollback-v1.head"),
      };
      const oldHead = fs.readFileSync(paths.head, "utf8");
      first.append({
        kind: "approval",
        key: "opaque-scope",
        generation: 1,
        status: "revoked",
        bindingDigest: "b",
      });
      fs.writeFileSync(paths.head, oldHead);
      expect(
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }).state(
          "approval",
          "opaque-scope",
        ),
      ).toMatchObject({ generation: 1, status: "revoked" });
      fs.writeFileSync(
        paths.journal,
        fs.readFileSync(paths.journal, "utf8").split("\n").slice(0, 1).join("\n") + "\n",
      );
      expect(
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }).state(
          "approval",
          "opaque-scope",
        ),
      ).toMatchObject({ generation: 1, status: "revoked" });
      expect(() =>
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: "wrong-key" }),
      ).toThrow(/GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a valid journal tail after a head-replace crash", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-v9-recovery-"));
    try {
      const ledger = createGovernorHostAntiRollbackLedger({
        stateDir: root,
        signingKey: ledgerKey,
        allowInitialization: true,
      });
      ledger.append({
        kind: "approval",
        key: "opaque-scope",
        generation: 0,
        status: "approved",
        bindingDigest: "a",
      });
      const { head } = {
        head: path.join(root, "host-governor", "anti-rollback-v1.head"),
      };
      const preAppendHead = fs.readFileSync(head, "utf8");
      ledger.append({
        kind: "approval",
        key: "opaque-scope",
        generation: 1,
        status: "revoked",
        bindingDigest: "b",
      });
      fs.writeFileSync(head, preAppendHead);
      expect(
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }).state(
          "approval",
          "opaque-scope",
        ),
      ).toMatchObject({ generation: 1, status: "revoked" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("signs memory ordering high-water and rejects ordering tamper", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-v22-memory-ordering-"));
    try {
      const ordering = {
        scopeEpoch: 0,
        observedAt: 10,
        recordedAt: 11,
        sourceRank: 600,
        confidenceMillionths: 1_000_000,
        taskVersion: 2,
        objectiveRevision: 1,
        planVersion: 1,
        taskDigest: "a".repeat(64),
      };
      const ledger = createGovernorHostAntiRollbackLedger({
        stateDir: root,
        signingKey: ledgerKey,
        allowInitialization: true,
      });
      ledger.append({
        kind: "memory",
        key: "opaque-memory-fact",
        generation: 1,
        status: "memory_current",
        bindingDigest: "b".repeat(64),
        ordering,
      });
      expect(
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }).state(
          "memory",
          "opaque-memory-fact",
        ),
      ).toMatchObject({ ordering });

      const journal = path.join(root, "host-governor", "anti-rollback-v1.journal");
      const entry = JSON.parse(fs.readFileSync(journal, "utf8").trim()) as {
        ordering: { observedAt: number };
      };
      entry.ordering.observedAt += 1;
      fs.writeFileSync(journal, `${JSON.stringify(entry)}\n`);
      expect(
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }).state(
          "memory",
          "opaque-memory-fact",
        ),
      ).toMatchObject({ ordering });
      fs.writeFileSync(journal, "corrupt\n");
      fs.writeFileSync(path.join(root, "host-governor", "anti-rollback-v1.head"), "corrupt\n");
      expect(() =>
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }),
      ).toThrow(/GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles primary delivery state after a crash between ledger and SQLite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v9-crash-" },
      async (state) => {
        let crash = true;
        const hostEnv = {
          ...syntheticGovernorSecretsEnvironment(state.stateDir),
          OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: ledgerKey,
          OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: receiptKey,
        };
        const secrets = resolveGovernorSecrets(hostEnv);
        const persistence = createGovernorHostPersistence({
          env: hostEnv,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
          testAfterLedgerAppend: () => {
            if (crash) {
              crash = false;
              throw new Error("synthetic crash after ledger append");
            }
          },
        });
        const broker = createHostGovernorBroker({
          secrets,
          persistence,
        });
        const handle = register(broker);
        expect(() => broker.capabilities.revokeDeliveryAdapter({ handle })).toThrow(
          /synthetic crash/,
        );
        expect(broker.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
        });
        expect(
          db
            .prepare(
              "SELECT certification_generation, status FROM governor_delivery_certifications",
            )
            .get(),
        ).toMatchObject({ certification_generation: 1, status: "revoked" });
      },
    );
  });

  it("recovers either signed copy and fails closed when both are missing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v9-missing-" },
      async (state) => {
        createGovernorHostAntiRollbackLedger({
          stateDir: path.join(state.stateDir, "state"),
          signingKey: ledgerKey,
          allowInitialization: true,
        });
        const paths = ledgerPaths(state.stateDir);
        fs.unlinkSync(paths.head);
        expect(
          createGovernorHostAntiRollbackLedger({
            stateDir: path.join(state.stateDir, "state"),
            signingKey: ledgerKey,
          }).state("memory", "absent"),
        ).toBeNull();
        fs.unlinkSync(paths.head);
        fs.unlinkSync(paths.journal);
        expect(() =>
          createGovernorHostAntiRollbackLedger({
            stateDir: path.join(state.stateDir, "state"),
            signingKey: ledgerKey,
          }),
        ).toThrow(/GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED/u);
      },
    );
  });

  it("initializes only beside an empty primary and rejects complete authority loss later", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v24-authority-loss-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        expect(() =>
          createGovernorHostPersistence({
            env,
            stateDir: state.stateDir,
            secrets,
            testMode: true,
          }),
        ).not.toThrow();
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
        });
        db.prepare(
          "INSERT INTO governor_scope_epochs(scope_key, epoch, updated_at) VALUES (?, ?, ?)",
        ).run("gref_established_primary_fixture", 0, 1);
        closeOpenClawStateDatabase();
        const paths = ledgerPaths(state.stateDir);
        fs.unlinkSync(paths.head);
        fs.unlinkSync(paths.journal);
        expect(() =>
          createGovernorHostPersistence({
            env,
            stateDir: state.stateDir,
            secrets,
            testMode: true,
          }),
        ).toThrow(/GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED/u);
      },
    );
  });
});
