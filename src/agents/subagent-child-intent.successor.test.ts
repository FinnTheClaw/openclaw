import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./subagent-registry.mocks.shared.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { compactSubagentChildIntentPayload } from "./subagent-child-intent-compaction.js";
import { expireSubagentReservationsAtomically } from "./subagent-child-intent-store-lifecycle.sqlite.js";
import { reserveGatewayAcceptanceReceipt } from "./subagent-gateway-acceptance-receipt-store.sqlite.js";
import {
  cancelSubagentChildIntent,
  reserveSubagentChildIntent,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("child-intent successor authority boundaries", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "NODE_ENV"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-successor-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("NODE_ENV", "test");
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const input = (operationKey: string, suffix: string) => ({
    childIntentKey: "same-canonical-shape",
    childSessionKey: `agent:main:subagent:${suffix}`,
    reservationRunId: `reservation-${suffix}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "agent:main:main",
    task: "same canonical shape",
    cleanup: "keep" as const,
    maxActiveChildren: 2,
    operationKey,
    intentRequestDigest: "same-request",
    intentBehaviorDigest: "same-preparation",
  });

  it("keeps named slots distinct, controller-scoped, and replayable after restart", () => {
    const slotA = reserveSubagentChildIntent(input("slot-a", "a"));
    const slotB = reserveSubagentChildIntent(input("slot-b", "b"));
    expect(slotA.disposition).toBe("owner");
    expect(slotB.disposition).toBe("owner");

    resetSubagentRegistryForTests({ persist: false });
    expect(reserveSubagentChildIntent(input("slot-a", "a")).disposition).toBe("duplicate");
    expect(reserveSubagentChildIntent(input("slot-b", "b")).disposition).toBe("duplicate");
    expect(
      cancelSubagentChildIntent(
        slotA.childIntentKey,
        slotA.controllerSessionKey!,
        slotA.operationKey,
      ),
    ).toBe(true);
    expect(reserveSubagentChildIntent(input("slot-a", "a")).disposition).toBe("duplicate");
    expect(reserveSubagentChildIntent(input("slot-b", "b")).disposition).toBe("duplicate");
  });

  it("makes cancellation win before a later receipt can be created", () => {
    const reservation = reserveSubagentChildIntent(input("cancel-before-receipt", "cancel"));
    expect(
      cancelSubagentChildIntent(
        reservation.childIntentKey,
        reservation.controllerSessionKey!,
        reservation.operationKey,
      ),
    ).toBe(true);
    expect(() =>
      reserveGatewayAcceptanceReceipt({
        acceptanceKey: reservation.childIntentKey,
        intentId: reservation.childIntentKey,
        controllerSessionKey: reservation.controllerSessionKey!,
        requestDigest: reservation.requestDigest!,
        resolvedDigest: reservation.resolvedDigest!,
        gatewayRunId: "late-gateway-run",
        childSessionKey: reservation.childSessionKey,
      }),
    ).toThrow("GOVERNOR_CHILD_INTENT_CANCELLED");
  });

  it("compacts terminal identity without retaining the task payload", () => {
    const payload = compactSubagentChildIntentPayload({
      intent_id: "intent-compact",
      controller_session_key: "agent:main:main",
      canonical_key: "canonical-compact",
      operation_key: "named-compact",
      request_digest: "request-compact",
      preparation_digest: "preparation-compact",
      resolved_digest: "resolved-compact",
      target_agent_id: "main",
      child_session_key: "agent:main:subagent:compact",
      reservation_run_id: "reservation-compact",
      state: "terminal",
      generation: 3,
      lease_owner: "owner-compact",
      lease_expires_at: null,
      registered_run_id: "run-compact",
      provider_run_id: "provider-compact",
      gateway_receipt_id: "receipt-compact",
      cancel_requested_at: null,
      created_at: 1,
      updated_at: 2,
      payload_json: JSON.stringify({ task: "private raw task" }),
    });
    expect(payload).not.toContain("private raw task");
    expect(JSON.parse(payload)).toMatchObject({
      schema: "openclaw.child-intent.terminal.v1",
      operationKey: "named-compact",
      generation: 3,
      resolvedDigest: "resolved-compact",
    });
  });

  it("compacts cancellation and expiry tombstones while retaining their identity rows", () => {
    const cancelled = reserveSubagentChildIntent(input("cancel-payload", "cancel-payload"));
    expect(
      cancelSubagentChildIntent(
        cancelled.childIntentKey,
        cancelled.controllerSessionKey!,
        cancelled.operationKey,
      ),
    ).toBe(true);
    runOpenClawStateWriteTransaction(({ db }) => {
      const row = db
        .prepare("SELECT state, payload_json FROM subagent_child_intents WHERE operation_key = ?")
        .get("cancel-payload") as { state?: string; payload_json?: string } | undefined;
      expect(row?.state).toBe("cancelled_requested");
      expect(row?.payload_json).not.toContain("same canonical shape");
    });

    const expiring = reserveSubagentChildIntent({
      ...input("", "expiry-payload"),
      childIntentKey: "expiry-canonical",
      operationKey: undefined,
    });
    expect(expiring.disposition).toBe("owner");
    expect(expireSubagentReservationsAtomically(Date.now() + 31_000)).toContain(
      expiring.reservationRunId,
    );
    runOpenClawStateWriteTransaction(({ db }) => {
      const row = db
        .prepare("SELECT state, payload_json FROM subagent_child_intents WHERE canonical_key = ?")
        .get("expiry-canonical") as { state?: string; payload_json?: string } | undefined;
      expect(row?.state).toBe("expired");
      expect(row?.payload_json).not.toContain("same canonical shape");
    });
  });
});
