import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { reconcileSubagentChildIntent } from "./subagent-child-intent-reconciliation.js";
import { buildGatewayAcceptanceReceiptEnvelope } from "./subagent-gateway-acceptance-receipt-auth.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "./subagent-gateway-acceptance-receipt-runtime.js";
import {
  claimGatewayAcceptanceForDispatch,
  fencePriorGatewayAcceptanceReceipts,
  isGatewayAcceptanceDispatchAllowed,
  isGatewayAcceptanceReceiptActiveForReplay,
  markGatewayAcceptanceDispatchClaimed,
  markGatewayAcceptanceFailedAfterStart,
  markGatewayAcceptanceFailedBeforeStart,
  markGatewayAcceptanceRunnable,
  markGatewayAcceptanceStartAuthorized,
  markGatewayAcceptanceStarted,
  readGatewayAcceptanceReceipt,
  requestGatewayAcceptanceCancel,
  reserveGatewayAcceptanceReceipt,
} from "./subagent-gateway-acceptance-receipt-store.sqlite.js";
import {
  markSubagentChildIntentDispatching,
  markSubagentChildIntentUnknown,
  reserveSubagentChildIntent,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("successor gateway receipt invariants", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR", "NODE_ENV"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-receipt-successor-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("NODE_ENV", "test");
    installGatewayAcceptanceReceiptSigner({
      signingKey: "fixture-gateway-receipt-key",
      generation: "fixture-generation",
    });
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    clearGatewayAcceptanceReceiptSigner();
    env.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const input = (suffix: string, epoch: string, runId: string) => {
    const acceptanceKey = `successor-receipt-${suffix}`;
    const intentId = `successor-intent-${suffix}`;
    const controllerSessionKey = "agent:main:main";
    const childSessionKey = `agent:main:subagent:${suffix}`;
    return {
      acceptanceKey,
      intentId,
      controllerSessionKey,
      requestDigest: `request-${suffix}`,
      resolvedDigest: `resolved-${suffix}`,
      gatewayRunId: runId,
      childSessionKey,
      acceptanceEpoch: epoch,
      envelope: buildGatewayAcceptanceReceiptEnvelope({
        acceptanceKey,
        intentId,
        controllerSessionKey,
        targetAgentId: "main",
        childSessionKey,
        requestDigest: `request-${suffix}`,
        preparationDigest: `request-${suffix}`,
        resolvedDigest: `resolved-${suffix}`,
        request: { message: "opaque test request" },
        gatewayRunId: runId,
        acceptanceEpoch: epoch,
        receiptGeneration: 0,
      }),
    };
  };

  it("retries a proven pre-start failure across gateway epochs without binding to the old epoch", () => {
    const first = input("epoch-retry", "gateway-epoch-a", "gateway-run-a");
    expect(reserveGatewayAcceptanceReceipt(first).lifecycle).toBe("preaccepted");
    expect(markGatewayAcceptanceRunnable(first)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(first)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(first)).toBe(true);
    expect(markGatewayAcceptanceFailedBeforeStart(first)).toBe(true);
    expect(
      isGatewayAcceptanceReceiptActiveForReplay(
        readGatewayAcceptanceReceipt(first.acceptanceKey)!.lifecycle,
      ),
    ).toBe(false);
    closeOpenClawStateDatabaseForTest();
    const retry = input("epoch-retry", "gateway-epoch-b", "gateway-run-b");
    const next = reserveGatewayAcceptanceReceipt(retry);
    expect(next.receiptGeneration).toBe(1);
    expect(next.gatewayRunId).toBe("gateway-run-b");
    expect(next.acceptanceEpoch).toBe("gateway-epoch-b");
  });

  it("requires the durable start authorization CAS immediately before provider start", () => {
    const value = input("start-authorized", "gateway-epoch", "gateway-run");
    const receipt = reserveGatewayAcceptanceReceipt(value);
    expect(markGatewayAcceptanceRunnable(receipt)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(receipt)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(receipt)).toBe(true);
    expect(markGatewayAcceptanceStartAuthorized(receipt)).toBe(true);
    expect(readGatewayAcceptanceReceipt(value.acceptanceKey)?.lifecycle).toBe("start_authorized");
    expect(markGatewayAcceptanceStartAuthorized(receipt)).toBe(false);
    expect(markGatewayAcceptanceStarted(receipt)).toBe(true);
  });

  it("retires the matching child row for a proven failed-before-start retry", () => {
    const value = input("failed-child", "gateway-epoch-a", "gateway-run-a");
    const reservation = reserveSubagentChildIntent({
      childIntentKey: value.acceptanceKey,
      childSessionKey: value.childSessionKey,
      reservationRunId: "reservation-failed-child",
      requesterSessionKey: value.controllerSessionKey,
      requesterDisplayKey: value.controllerSessionKey,
      task: "private failed child task",
      cleanup: "keep",
      operationKey: "failed-child",
      intentRequestDigest: value.requestDigest,
      intentBehaviorDigest: value.requestDigest,
    });
    expect(reservation.disposition).toBe("owner");
    expect(reserveGatewayAcceptanceReceipt(value).lifecycle).toBe("preaccepted");
    markSubagentChildIntentDispatching({
      childIntentKey: value.acceptanceKey,
      reservationToken: reservation.reservationToken!,
    });
    markSubagentChildIntentUnknown({
      childIntentKey: value.acceptanceKey,
      reservationToken: reservation.reservationToken!,
      providerRunId: value.gatewayRunId,
      retainOwnership: true,
    });
    expect(markGatewayAcceptanceRunnable(value)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(value)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(value)).toBe(true);
    expect(markGatewayAcceptanceFailedBeforeStart(value)).toBe(true);

    runOpenClawStateWriteTransaction(({ db }) => {
      const row = db
        .prepare(
          "SELECT state, generation, payload_json FROM subagent_child_intents WHERE canonical_key = ?",
        )
        .get(value.acceptanceKey) as
        | { state?: string; generation?: number; payload_json?: string }
        | undefined;
      expect(row?.state).toBe("expired");
      expect(row?.generation).toBe(3);
      expect(row?.payload_json).not.toContain("private failed child task");
    });
    expect(
      reserveSubagentChildIntent({
        childIntentKey: value.acceptanceKey,
        childSessionKey: value.childSessionKey,
        reservationRunId: "reservation-failed-child-retry",
        requesterSessionKey: value.controllerSessionKey,
        requesterDisplayKey: value.controllerSessionKey,
        task: "private failed child task",
        cleanup: "keep",
        operationKey: "failed-child",
        intentRequestDigest: value.requestDigest,
        intentBehaviorDigest: value.requestDigest,
      }).disposition,
    ).toBe("owner");
  });

  it.each([
    ["preaccepted", true],
    ["runnable", true],
    ["dispatch_claimed", true],
    ["accepted", true],
    ["start_authorized", true],
    ["started", true],
    ["unknown", true],
    ["not_accepted", false],
    ["failed_before_start", false],
    ["failed_after_start", true],
    ["cancel_requested", false],
    ["cancelled", false],
    ["terminal", false],
  ] as const)("uses the signed replay lifecycle fence for %s", (lifecycle, active) => {
    expect(isGatewayAcceptanceReceiptActiveForReplay(lifecycle)).toBe(active);
  });

  it("does not adopt a failure after provider start", async () => {
    const value = input("failed-after-start", "gateway-epoch", "gateway-run");
    const receipt = reserveGatewayAcceptanceReceipt(value);
    expect(markGatewayAcceptanceRunnable(receipt)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(receipt)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(receipt)).toBe(true);
    expect(markGatewayAcceptanceStarted(receipt)).toBe(true);
    expect(markGatewayAcceptanceFailedAfterStart(receipt)).toBe(true);
    await expect(
      reconcileSubagentChildIntent({
        reservation: {
          disposition: "duplicate",
          childIntentKey: value.acceptanceKey,
          childSessionKey: value.childSessionKey,
          reservationRunId: value.gatewayRunId,
          reservationToken: "token",
          dispatchState: "unknown",
          durableReceiptRequired: true,
        },
        waitForProvider: async () => ({ providerStarted: false }),
        lookupAcceptance: () => readGatewayAcceptanceReceipt(value.acceptanceKey),
        adopt: () => true,
        abandon: () => true,
      }),
    ).resolves.toBe("duplicate");
  });

  it("makes cancellation win before invocation after the handoff read", () => {
    const value = input("cancel-race", "gateway-epoch", "gateway-run");
    const receipt = reserveGatewayAcceptanceReceipt(value);
    expect(markGatewayAcceptanceRunnable(receipt)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(receipt)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(receipt)).toBe(true);
    expect(requestGatewayAcceptanceCancel(value)).toBe(true);
    let physicalInvocation = false;
    if (isGatewayAcceptanceDispatchAllowed(value)) {
      physicalInvocation = true;
    }
    expect(physicalInvocation).toBe(false);
    expect(readGatewayAcceptanceReceipt(value.acceptanceKey)?.lifecycle).toBe("cancel_requested");
  });

  it("rejects a target substitution while accepting a stable inferred target replay", () => {
    const first = input("target-binding", "gateway-epoch-a", "gateway-run-a");
    const firstReceipt = reserveGatewayAcceptanceReceipt(first);
    expect(markGatewayAcceptanceRunnable(firstReceipt)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(firstReceipt)).toBe(true);
    expect(claimGatewayAcceptanceForDispatch(firstReceipt)).toBe(true);
    expect(markGatewayAcceptanceFailedBeforeStart(firstReceipt)).toBe(true);
    closeOpenClawStateDatabaseForTest();
    expect(
      reserveGatewayAcceptanceReceipt(input("target-binding", "gateway-epoch-b", "gateway-run-b"))
        .receiptGeneration,
    ).toBe(1);
    const changed = {
      ...input("target-binding", "gateway-epoch-b", "gateway-run-b"),
      envelope: buildGatewayAcceptanceReceiptEnvelope({
        ...input("target-binding", "gateway-epoch-b", "gateway-run-b"),
        targetAgentId: "other",
        request: { message: "opaque test request" },
        receiptGeneration: 1,
      }),
    };
    expect(() => reserveGatewayAcceptanceReceipt(changed)).toThrow("resolved binding");
  });

  it("quarantines an invalid legacy receipt instead of silently skipping it", () => {
    const value = input("legacy-invalid", "old-epoch", "gateway-run");
    reserveGatewayAcceptanceReceipt(value);
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "UPDATE subagent_gateway_acceptance_receipts SET signature = ? WHERE acceptance_key = ?",
      ).run("invalid", value.acceptanceKey);
    });
    expect(fencePriorGatewayAcceptanceReceipts("new-epoch")).toBe(1);
    runOpenClawStateWriteTransaction(({ db }) => {
      const row = db
        .prepare(
          "SELECT lifecycle, payload_json FROM subagent_gateway_acceptance_receipts WHERE acceptance_key = ?",
        )
        .get(value.acceptanceKey) as { lifecycle?: string; payload_json?: string } | undefined;
      expect(row?.lifecycle).toBe("unknown");
      expect(row?.payload_json).toContain("AUTHENTICATION_UNAVAILABLE");
    });
  });
});
