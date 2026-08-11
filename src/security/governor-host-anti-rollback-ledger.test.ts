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
      const first = createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey });
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
      ).toThrow(/binding/);
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
      expect(() =>
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: ledgerKey }),
      ).toThrow(/truncated|head/);
      expect(() =>
        createGovernorHostAntiRollbackLedger({ stateDir: root, signingKey: "wrong-key" }),
      ).toThrow(/key mismatch|integrity|head/);
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

  it("fails closed when the independent head or ledger is missing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v9-missing-" },
      async (state) => {
        createGovernorHostAntiRollbackLedger({
          stateDir: path.join(state.stateDir, "state"),
          signingKey: ledgerKey,
        });
        const paths = ledgerPaths(state.stateDir);
        fs.unlinkSync(paths.head);
        expect(() =>
          createGovernorHostAntiRollbackLedger({
            stateDir: path.join(state.stateDir, "state"),
            signingKey: ledgerKey,
          }),
        ).toThrow(/incomplete|head/);
      },
    );
  });
});
