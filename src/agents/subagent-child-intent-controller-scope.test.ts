import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  cancelSubagentChildIntent,
  getSubagentChildIntentReservationToken,
  markSubagentChildIntentDispatching,
  reserveSubagentChildIntent,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("child intent controller-scoped ownership", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-controller-scope-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    env.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not clobber same-key ownership or cancel the other controller", () => {
    const childIntentKey = "same-canonical-child-key";
    const first = reserveSubagentChildIntent({
      childIntentKey,
      childSessionKey: "agent:one:subagent:child",
      reservationRunId: "reservation-one",
      requesterSessionKey: "agent:one:main",
      requesterDisplayKey: "agent:one:main",
      task: "controller one",
      cleanup: "keep",
      maxActiveChildren: 1,
    });
    const second = reserveSubagentChildIntent({
      childIntentKey,
      childSessionKey: "agent:two:subagent:child",
      reservationRunId: "reservation-two",
      requesterSessionKey: "agent:two:main",
      requesterDisplayKey: "agent:two:main",
      task: "controller two",
      cleanup: "keep",
      maxActiveChildren: 1,
    });

    expect(first.disposition).toBe("owner");
    expect(second.disposition).toBe("owner");
    expect(getSubagentChildIntentReservationToken(childIntentKey)).toBeUndefined();
    expect(getSubagentChildIntentReservationToken(childIntentKey, "agent:one:main")).toBe(
      first.reservationToken,
    );
    expect(getSubagentChildIntentReservationToken(childIntentKey, "agent:two:main")).toBe(
      second.reservationToken,
    );

    expect(cancelSubagentChildIntent(childIntentKey, "")).toBe(false);
    expect(cancelSubagentChildIntent(childIntentKey, "agent:one:main")).toBe(true);
    expect(
      getSubagentChildIntentReservationToken(childIntentKey, "agent:one:main"),
    ).toBeUndefined();
    expect(getSubagentChildIntentReservationToken(childIntentKey, "agent:two:main")).toBe(
      second.reservationToken,
    );

    markSubagentChildIntentDispatching({
      childIntentKey,
      reservationToken: second.reservationToken!,
    });
    expect(cancelSubagentChildIntent(childIntentKey, "agent:two:main")).toBe(true);
  });
});
