import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createHostGovernorBroker } from "./governor-host-broker.js";
import {
  getSyntheticHostObservableSends,
  resetSyntheticHostDeliveryAttempts,
} from "./governor-host-delivery-implementations.js";
import { createGovernorHostPersistence } from "./governor-host-persistence.js";
import { createGovernorTestHostBindings } from "./governor-host-readonly.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "./governor-host-secrets.js";

afterEach(() => closeOpenClawStateDatabase());

async function runClaimWorker(params: {
  stateDir: string;
  receiptId: string;
  now: number;
  outputPath: string;
}): Promise<void> {
  const worker = fileURLToPath(
    new URL("./test-helpers/governor-owner-ingress-claim-worker.ts", import.meta.url),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        worker,
        params.stateDir,
        params.receiptId,
        String(params.now),
        params.outputPath,
      ],
      { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe" },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`claim worker exited ${code}: ${stderr}`)),
    );
  });
}

describe("governor V14 host concurrency fences", () => {
  it("prevents a retained adapter from sending after durable revocation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-retained-delivery-" },
      async (state) => {
        resetSyntheticHostDeliveryAttempts("test", "retained-revoke");
        const broker = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const handle = broker.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config: { observerKey: "retained-revoke" },
          generation: 0,
        });
        const retained = broker.deliveryResolver.resolve(handle);
        if (!retained) {
          throw new Error("expected retained adapter");
        }
        expect(broker.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
        await expect(
          retained.send({ deliveryKey: "retained-key", payload: { text: "fixture" } }),
        ).resolves.toMatchObject({ status: "not_sent" });
        expect(getSyntheticHostObservableSends("test", "retained-revoke")).toEqual([]);
      },
    );
  });

  it("does not report revocation success while an effect boundary is active", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-delivery-boundary-" },
      async (state) => {
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const handle = broker.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config: {},
          generation: 0,
        });
        const entry = broker.deliveryResolver.resolve(handle);
        if (!entry) {
          throw new Error("expected certified adapter");
        }
        const effect = {
          handle,
          identityKey: entry.identityKey,
          implementationDigest: entry.implementationDigest,
          configDigest: entry.configDigest,
          generation: entry.generation,
          signature: entry.signature,
          observedAt: 100,
          claimId: "claim-v14-boundary",
          deploymentIdentity: entry.binding.deploymentIdentity,
          deliveryKey: "delivery-v14-boundary",
          payloadDigest: governorDigest({ text: "fixture" }),
        };
        expect(persistence.claimDeliveryEffect(effect)).toBe(true);
        expect(persistence.startDeliveryEffect(effect)).toBe(true);
        expect(() => broker.capabilities.revokeDeliveryAdapter({ handle })).toThrow(
          /not durably applied/u,
        );
        expect(broker.deliveryResolver.resolve(handle)).not.toBeNull();
        expect(persistence.completeDeliveryEffect(effect.claimId, 101)).toBe(true);
        expect(broker.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
      },
    );
  });

  it("cancels an admitted effect when revocation wins before the send boundary", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-delivery-claimed-revoke-" },
      async (state) => {
        resetSyntheticHostDeliveryAttempts("test", "claimed-revoke");
        const env = syntheticGovernorSecretsEnvironment(state.stateDir);
        const secrets = resolveGovernorSecrets(env);
        const persistence = createGovernorHostPersistence({
          env,
          stateDir: state.stateDir,
          secrets,
          testMode: true,
        });
        const broker = createHostGovernorBroker({ secrets, persistence });
        const handle = broker.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config: { observerKey: "claimed-revoke" },
          generation: 0,
        });
        const retained = broker.deliveryResolver.resolve(handle);
        if (!retained) {
          throw new Error("expected retained delivery entry");
        }
        const payload = { text: "fixture" };
        const effect = {
          handle,
          identityKey: retained.identityKey,
          implementationDigest: retained.implementationDigest,
          configDigest: retained.configDigest,
          generation: retained.generation,
          signature: retained.signature,
          observedAt: 100,
          claimId: "claim-v14-revocation-wins",
          deploymentIdentity: retained.binding.deploymentIdentity,
          deliveryKey: "delivery-v14-revocation-wins",
          payloadDigest: governorDigest(payload),
        };
        expect(persistence.claimDeliveryEffect(effect)).toBe(true);
        expect(broker.capabilities.revokeDeliveryAdapter({ handle })).toBe(true);
        expect(persistence.deliveryEffectState(effect)).toBe("cancelled");
        expect(persistence.startDeliveryEffect(effect)).toBe(false);
        await expect(
          retained.send({ deliveryKey: effect.deliveryKey, payload }),
        ).resolves.toMatchObject({ status: "not_sent" });
        expect(getSyntheticHostObservableSends("test", "claimed-revoke")).toEqual([]);
      },
    );
  });

  it("does not blindly resend after a crash at the effect boundary", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-delivery-crash-" },
      async (state) => {
        resetSyntheticHostDeliveryAttempts("test", "effect-crash");
        const broker = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const handle = broker.capabilities.registerStaticDeliveryAdapter({
          implementationId: "synthetic",
          config: { observerKey: "effect-crash", throwBeforeSend: true },
          generation: 0,
        });
        const entry = broker.deliveryResolver.resolve(handle);
        if (!entry) {
          throw new Error("expected certified delivery entry");
        }
        const request = { deliveryKey: "effect-crash-key", payload: { text: "fixture" } };
        await expect(entry.send(request)).rejects.toThrow(/interrupted before observable send/u);
        await expect(entry.send(request)).resolves.toMatchObject({
          status: "unknown",
          reconcileSupported: true,
        });
        expect(getSyntheticHostObservableSends("test", "effect-crash")).toEqual([]);
      },
    );
  });

  it("claims an owner receipt once and recovers a crash after task ingestion", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-claim-" },
      async (state) => {
        const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const receiptId = first.capabilities.submitAuthenticatedOwnerIngress({
          channel: "signal",
          accountId: "claim-account-fixture",
          gatewayInstanceId: "claim-gateway-fixture",
          ownerPrincipal: "claim-owner-fixture",
          sourceMessageId: "claim-message-fixture",
          sourceSequence: 10,
          action: "repair",
          scopeKey: "claim-scope-fixture",
          nonce: "claim-nonce-fixture",
          observedAt: 100,
          expiresAt: 100_000,
        });
        const second = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const firstClaim = first.ownerIngressResolver.claim(receiptId, 101);
        expect(firstClaim).not.toBeNull();
        expect(second.ownerIngressResolver.claim(receiptId, 102)).toBeNull();
        if (!firstClaim) {
          throw new Error("expected first claim");
        }
        expect(
          first.ownerIngressResolver.finalize(Object.freeze({ ...firstClaim }), "forged-task", 103),
        ).toBe(false);
        const recoveredClaim = second.ownerIngressResolver.claim(receiptId, 30_102);
        expect(recoveredClaim).not.toBeNull();
        if (!recoveredClaim) {
          throw new Error("expected recovered claim");
        }
        expect(
          second.ownerIngressResolver.finalize(recoveredClaim, "task-after-recovery", 30_103),
        ).toBe(true);
        expect(first.ownerIngressResolver.claim(receiptId, 30_104)).toBeNull();
      },
    );
  });

  it("allows exactly one claim across competing host processes", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-processes-" },
      async (state) => {
        const broker = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const receiptId = broker.capabilities.submitAuthenticatedOwnerIngress({
          channel: "signal",
          accountId: "process-account-fixture",
          gatewayInstanceId: "process-gateway-fixture",
          ownerPrincipal: "process-owner-fixture",
          sourceMessageId: "process-message-fixture",
          sourceSequence: 12,
          action: "repair",
          scopeKey: "process-scope-fixture",
          nonce: "process-nonce-fixture",
          observedAt: 100,
          expiresAt: 100_000,
        });
        closeOpenClawStateDatabase();
        const outputs = Array.from({ length: 8 }, (_, index) =>
          path.join(state.root, `claim-worker-${index}.json`),
        );
        await Promise.all(
          outputs.map((outputPath) =>
            runClaimWorker({ stateDir: state.stateDir, receiptId, now: 101, outputPath }),
          ),
        );
        const claims = outputs.map(
          (outputPath) =>
            JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
              claimed: boolean;
              errored: boolean;
              errorMessage: string;
            },
        );
        expect(claims.filter((result) => result.errored)).toEqual([]);
        expect(claims.filter((result) => result.claimed)).toHaveLength(1);
      },
    );
  });

  it("revokes an unconsumed owner receipt without exposing it to later claims", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-revoke-" },
      async (state) => {
        const broker = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const receiptId = broker.capabilities.submitAuthenticatedOwnerIngress({
          channel: "imessage",
          accountId: "revoked-account-fixture",
          gatewayInstanceId: "revoked-gateway-fixture",
          ownerPrincipal: "revoked-owner-fixture",
          sourceMessageId: "revoked-message-fixture",
          sourceSequence: 6,
          action: "revoke",
          scopeKey: "revoked-scope-fixture",
          nonce: "revoked-nonce-fixture",
          observedAt: 100,
          expiresAt: 1_000,
        });
        expect(broker.capabilities.revokeOwnerIngressReceipt({ receiptId, observedAt: 101 })).toBe(
          true,
        );
        expect(broker.ownerIngressResolver.claim(receiptId, 102)).toBeNull();
      },
    );
  });

  it("reconciles a crash after the consumed ledger write but before SQLite finalization", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-finalize-crash-" },
      async (state) => {
        const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const receiptId = first.capabilities.submitAuthenticatedOwnerIngress({
          channel: "signal",
          accountId: "finalize-account-fixture",
          gatewayInstanceId: "finalize-gateway-fixture",
          ownerPrincipal: "finalize-owner-fixture",
          sourceMessageId: "finalize-message-fixture",
          sourceSequence: 8,
          action: "repair",
          scopeKey: "finalize-scope-fixture",
          nonce: "finalize-nonce-fixture",
          observedAt: 100,
          expiresAt: 100_000,
        });
        const claim = first.ownerIngressResolver.claim(receiptId, 101);
        if (!claim) {
          throw new Error("expected initial owner claim");
        }
        expect(first.ownerIngressResolver.finalize(claim, "task-finalize-recovery", 102)).toBe(
          true,
        );
        closeOpenClawStateDatabase();
        const db = openOpenClawStateDatabase({
          env: { OPENCLAW_STATE_DIR: state.stateDir },
        }).db;
        db.prepare(
          "UPDATE governor_owner_ingress_receipts SET consumed_at = NULL WHERE receipt_id = ?",
        ).run(receiptId);
        closeOpenClawStateDatabase();

        const restarted = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const recovered = restarted.ownerIngressResolver.claim(receiptId, 30_102);
        if (!recovered) {
          throw new Error("expected recoverable finalization claim");
        }
        expect(
          restarted.ownerIngressResolver.finalize(recovered, "task-finalize-recovery", 30_103),
        ).toBe(true);
        expect(restarted.ownerIngressResolver.claim(receiptId, 30_104)).toBeNull();
      },
    );
  });

  it("keeps a consumed owner receipt closed after primary database replay", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "governor-v14-owner-replay-" },
      async (state) => {
        const first = createGovernorTestHostBindings({ stateDir: state.stateDir });
        const receiptId = first.capabilities.submitAuthenticatedOwnerIngress({
          channel: "imessage",
          accountId: "replay-account-fixture",
          gatewayInstanceId: "replay-gateway-fixture",
          ownerPrincipal: "replay-owner-fixture",
          sourceMessageId: "replay-message-fixture",
          sourceSequence: 4,
          action: "reinvestigate",
          scopeKey: "replay-scope-fixture",
          nonce: "replay-nonce-fixture",
          observedAt: 100,
          expiresAt: 100_000,
        });
        const primary = path.join(state.stateDir, "state", "openclaw.sqlite");
        const snapshot = path.join(state.root, "owner-primary-before-consume.sqlite");
        closeOpenClawStateDatabase();
        fs.copyFileSync(primary, snapshot);
        const claim = first.ownerIngressResolver.claim(receiptId, 101);
        if (!claim) {
          throw new Error("expected owner claim");
        }
        expect(first.ownerIngressResolver.finalize(claim, "task-consumed", 102)).toBe(true);
        closeOpenClawStateDatabase();
        fs.copyFileSync(snapshot, primary);
        const restarted = createGovernorTestHostBindings({ stateDir: state.stateDir });
        expect(restarted.ownerIngressResolver.claim(receiptId, 103)).toBeNull();
        const delayedReceipt = restarted.capabilities.submitAuthenticatedOwnerIngress({
          channel: "imessage",
          accountId: "replay-account-fixture",
          gatewayInstanceId: "replay-gateway-fixture",
          ownerPrincipal: "replay-owner-fixture",
          sourceMessageId: "replay-delayed-message-fixture",
          sourceSequence: 3,
          action: "repair",
          scopeKey: "replay-scope-fixture",
          nonce: "replay-delayed-nonce-fixture",
          observedAt: 103,
          expiresAt: 100_000,
        });
        expect(restarted.ownerIngressResolver.claim(delayedReceipt, 104)).toBeNull();
      },
    );
  });
});
