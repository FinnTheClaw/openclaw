import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resolveSubagentChildIntentBehaviorDigest } from "./subagent-child-intent.js";
import {
  markGatewayAcceptanceNotAccepted,
  reserveGatewayAcceptanceReceipt,
} from "./subagent-gateway-acceptance-receipt-store.sqlite.js";
import {
  cancelSubagentChildIntent,
  abandonUnresolvedSubagentChildIntent,
  adoptSubagentChildIntent,
  markSubagentChildIntentDispatching,
  markSubagentChildIntentUnknown,
  releaseSubagentChildIntent,
  reserveSubagentChildIntent,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("durable child intent reservations", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-intent-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps one durable reservation identity across restart and dispatch transition", () => {
    const input = {
      childIntentKey: "child_intent_same-logical-operation",
      childSessionKey: "agent:main:subagent:same-logical-operation",
      reservationRunId: "child_reservation_same-logical-operation",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "one logical child",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const first = reserveSubagentChildIntent(input);
    expect(first.disposition).toBe("owner");
    markSubagentChildIntentDispatching({
      childIntentKey: first.childIntentKey,
      reservationToken: first.reservationToken!,
    });

    resetSubagentRegistryForTests({ persist: false });

    const recovered = reserveSubagentChildIntent(input);
    expect(recovered).toMatchObject({
      disposition: "duplicate",
      childIntentKey: first.childIntentKey,
      childSessionKey: first.childSessionKey,
      reservationRunId: first.childIntentKey,
    });
    expect(first.reservationToken).toBeDefined();
    expect(recovered).toMatchObject({
      dispatchState: "dispatching",
      reservationToken: expect.any(String),
    });
    expect(
      adoptSubagentChildIntent({
        childIntentKey: recovered.childIntentKey,
        reservationToken: recovered.reservationToken!,
      }),
    ).toBe(true);
    const duplicate = reserveSubagentChildIntent(input);
    expect(duplicate).toMatchObject({
      disposition: "duplicate",
      childIntentKey: first.childIntentKey,
      reservationRunId: first.childIntentKey,
    });
    expect(duplicate.reservationToken).toBeUndefined();
  });

  it("reconciles an unknown dispatch only after proving pre-acceptance failure", () => {
    const input = {
      childIntentKey: "child_intent_unknown-reconcile",
      childSessionKey: "agent:main:subagent:unknown-reconcile",
      reservationRunId: "child_reservation_unknown-reconcile",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "unknown dispatch",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const first = reserveSubagentChildIntent(input);
    markSubagentChildIntentDispatching({
      childIntentKey: first.childIntentKey,
      reservationToken: first.reservationToken!,
    });
    reserveGatewayAcceptanceReceipt({
      acceptanceKey: first.childIntentKey,
      intentId: first.childIntentKey,
      controllerSessionKey: first.controllerSessionKey!,
      requestDigest: first.requestDigest!,
      resolvedDigest: first.resolvedDigest!,
      gatewayRunId: "provider-never-accepted",
      childSessionKey: first.childSessionKey,
      acceptanceEpoch: "test",
    });
    markGatewayAcceptanceNotAccepted({
      acceptanceKey: first.childIntentKey,
      gatewayRunId: "provider-never-accepted",
    });
    markSubagentChildIntentUnknown({
      childIntentKey: first.childIntentKey,
      reservationToken: first.reservationToken!,
      providerRunId: "provider-never-accepted",
    });
    resetSubagentRegistryForTests({ persist: false });
    const recovered = reserveSubagentChildIntent(input);
    expect(recovered).toMatchObject({
      disposition: "duplicate",
      dispatchState: "unknown",
      reservationToken: expect.any(String),
      existingRunId: "provider-never-accepted",
    });
    expect(
      abandonUnresolvedSubagentChildIntent({
        childIntentKey: recovered.childIntentKey,
        reservationToken: recovered.reservationToken!,
      }),
    ).toBe(true);
    const retried = reserveSubagentChildIntent(input);
    expect(retried.disposition).toBe("owner");
    releaseSubagentChildIntent({
      childIntentKey: retried.childIntentKey,
      reservationToken: retried.reservationToken!,
    });
  });

  it("fences a cancelled reservation before the dispatch transition", () => {
    const input = {
      childIntentKey: "child_intent_cancel-before-dispatch",
      childSessionKey: "agent:main:subagent:cancel-before-dispatch",
      reservationRunId: "child_reservation_cancel-before-dispatch",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "cancel before dispatch",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const first = reserveSubagentChildIntent(input);
    expect(first.disposition).toBe("owner");
    expect(cancelSubagentChildIntent(first.childIntentKey, first.controllerSessionKey!)).toBe(true);
    expect(() =>
      markSubagentChildIntentDispatching({
        childIntentKey: first.childIntentKey,
        reservationToken: first.reservationToken!,
      }),
    ).toThrow();
    expect(reserveSubagentChildIntent(input).disposition).toBe("duplicate");
  });

  it("expires an unsubmitted reservation after its bounded lease", () => {
    vi.useFakeTimers();
    try {
      const input = {
        childIntentKey: "child_intent_expiring-reservation",
        childSessionKey: "agent:main:subagent:expiring-reservation",
        reservationRunId: "child_reservation_expiring-reservation",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "expire before dispatch",
        cleanup: "keep" as const,
        maxActiveChildren: 3,
      };
      const first = reserveSubagentChildIntent(input);
      expect(first.disposition).toBe("owner");
      vi.advanceTimersByTime(31_000);
      resetSubagentRegistryForTests({ persist: false });
      const recovered = reserveSubagentChildIntent(input);
      expect(recovered.disposition).toBe("owner");
      expect(recovered.reservationToken).not.toBe(first.reservationToken);
      releaseSubagentChildIntent({
        childIntentKey: input.childIntentKey,
        reservationToken: recovered.reservationToken!,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["thinking", { thinking: "high" }],
    ["timeout", { runTimeoutSeconds: 42 }],
    ["light context", { lightContext: true }],
    ["completion delivery", { expectsCompletionMessage: false }],
    ["mount path", { attachMountPath: "/mnt/child" }],
    ["delivery route", { delivery: { channel: "fake", to: "other-thread" } }],
  ])("rejects a reused operation when %s changes", (label, change) => {
    const baseBehavior = {
      resolvedModel: "provider/model",
      resolvedModelRoute: "route-a",
      thinking: undefined,
      runTimeoutSeconds: 30,
      lightContext: false,
      expectsCompletionMessage: true,
      attachMountPath: undefined,
      delivery: { channel: "fake", to: "thread" },
    };
    const base = {
      childIntentKey: `child_intent_behavior-binding-${label}`,
      childSessionKey: `agent:main:subagent:behavior-binding-${label}`,
      reservationRunId: `child_reservation_behavior-binding-${label}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "behavior binding",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const first = reserveSubagentChildIntent({
      ...base,
      intentBehaviorDigest: resolveSubagentChildIntentBehaviorDigest(baseBehavior),
    });
    expect(first.disposition).toBe("owner");
    expect(() =>
      reserveSubagentChildIntent({
        ...base,
        intentBehaviorDigest: resolveSubagentChildIntentBehaviorDigest({
          ...baseBehavior,
          ...change,
        }),
      }),
    ).toThrow("behavior binding");
  });
});
