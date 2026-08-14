import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./subagent-registry.mocks.shared.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  resolveSubagentChildIntentBehaviorDigest,
  resolveSubagentChildIntentKey,
} from "./subagent-child-intent.js";
import {
  markGatewayAcceptanceNotAccepted,
  readGatewayAcceptanceReceipt,
  reserveGatewayAcceptanceReceipt,
} from "./subagent-gateway-acceptance-receipt-store.sqlite.js";
import { releaseRegisteredSubagentChildIntent } from "./subagent-registry-state.js";
import {
  cancelSubagentChildIntent,
  markSubagentChildIntentDispatching,
  markSubagentChildIntentUnknown,
  reserveSubagentChildIntent,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fsSync.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("child-intent authority boundaries", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-authority-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps explicit operation identity stable while allowing distinct slots", () => {
    const base = {
      requesterSessionKey: "agent:main:main",
      targetAgentId: "main",
      task: "slot task",
      operationKey: "slot-a",
    };
    expect(resolveSubagentChildIntentKey(base)).toBe(
      resolveSubagentChildIntentKey({ ...base, task: "changed behavior" }),
    );
    expect(resolveSubagentChildIntentKey(base)).not.toBe(
      resolveSubagentChildIntentKey({ ...base, operationKey: "slot-b" }),
    );
    const first = reserveSubagentChildIntent({
      childIntentKey: "child_op_same-operation",
      childSessionKey: "agent:main:subagent:same-operation",
      reservationRunId: "child_reservation_same-operation",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "same operation",
      cleanup: "keep",
      maxActiveChildren: 3,
      operationKey: "slot-a",
      intentRequestDigest: "request-a",
    });
    expect(first.disposition).toBe("owner");
    expect(() =>
      reserveSubagentChildIntent({
        childIntentKey: "child_op_same-operation-other-key",
        childSessionKey: first.childSessionKey,
        reservationRunId: first.reservationRunId,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: "same operation changed",
        cleanup: "keep",
        maxActiveChildren: 3,
        operationKey: "slot-a",
        intentRequestDigest: "request-b",
      }),
    ).toThrow("behavior binding");
  });

  it.each([
    ["mode", { mode: "session" }],
    ["cleanup", { cleanup: "delete" }],
    ["sandbox", { sandbox: "require" }],
    ["context", { context: "isolated" }],
    ["role", { role: "orchestrator" }],
    ["depth", { depth: 2 }],
    ["workspace", { workspaceDir: "/workspace/child" }],
    ["completion group", { completionGroup: { id: "group-b" } }],
    ["system prompt", { systemPromptDigest: "system-b" }],
    ["attachment materialization", { attachmentReceipt: { count: 2 } }],
    ["execution metadata", { executionMetadata: { cleanup: true } }],
  ])("binds resolved behavior field %s", (_label, change) => {
    const base = {
      resolvedModel: "provider/model",
      resolvedModelRoute: "route-a",
      runTimeoutSeconds: 30,
      lightContext: false,
      expectsCompletionMessage: true,
    };
    expect(resolveSubagentChildIntentBehaviorDigest(base)).not.toBe(
      resolveSubagentChildIntentBehaviorDigest({ ...base, ...change }),
    );
  });

  it("fences cancellation after dispatch claim and gateway acceptance across restart", () => {
    for (const stage of ["dispatching", "accepted"] as const) {
      const input = {
        childIntentKey: `child_intent_cancel-${stage}`,
        childSessionKey: `agent:main:subagent:cancel-${stage}`,
        reservationRunId: `child_reservation_cancel-${stage}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        task: `cancel ${stage}`,
        cleanup: "keep" as const,
        maxActiveChildren: 3,
      };
      const first = reserveSubagentChildIntent(input);
      markSubagentChildIntentDispatching({
        childIntentKey: first.childIntentKey,
        reservationToken: first.reservationToken!,
      });
      if (stage === "accepted") {
        markSubagentChildIntentUnknown({
          childIntentKey: first.childIntentKey,
          reservationToken: first.reservationToken!,
          providerRunId: `provider-${stage}`,
          retainOwnership: true,
        });
      }
      resetSubagentRegistryForTests({ persist: false });
      expect(cancelSubagentChildIntent(first.childIntentKey)).toBe(true);
      expect(reserveSubagentChildIntent(input).disposition).toBe("duplicate");
    }
  });

  it("does not let a stale projection resurrect a terminal child", () => {
    const input = {
      childIntentKey: "child_intent_projection-cas",
      childSessionKey: "agent:main:subagent:projection-cas",
      reservationRunId: "child_reservation_projection-cas",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "agent:main:main",
      task: "projection CAS",
      cleanup: "keep" as const,
      maxActiveChildren: 3,
    };
    const reservation = reserveSubagentChildIntent(input);
    markSubagentChildIntentDispatching({
      childIntentKey: reservation.childIntentKey,
      reservationToken: reservation.reservationToken!,
    });
    markSubagentChildIntentUnknown({
      childIntentKey: reservation.childIntentKey,
      reservationToken: reservation.reservationToken!,
      providerRunId: "provider-projection-cas",
      retainOwnership: true,
    });
    const registered = {
      ...input,
      runId: "provider-projection-cas",
      childIntentKey: reservation.childIntentKey,
      reservationOwnerToken: reservation.reservationToken,
      providerRunId: "provider-projection-cas",
      spawnAdmission: "dispatched" as const,
      createdAt: Date.now(),
      execution: { status: "running" as const },
    };
    saveSubagentRegistryToSqlite(new Map([[registered.runId, registered]]));
    releaseRegisteredSubagentChildIntent(registered.runId);
    const terminal = {
      ...registered,
      reservationOwnerToken: undefined,
      endedAt: Date.now(),
      execution: { status: "terminal" as const, endedAt: Date.now() },
    };
    saveSubagentRegistryToSqlite(new Map([[terminal.runId, terminal]]));
    saveSubagentRegistryToSqlite(
      new Map([
        [
          terminal.runId,
          {
            ...registered,
            reservationOwnerToken: undefined,
            endedAt: undefined,
            execution: { status: "running" as const },
          },
        ],
      ]),
    );
    expect(loadSubagentRegistryFromSqlite().get(terminal.runId)).toMatchObject({
      endedAt: terminal.endedAt,
      execution: { status: "terminal" },
    });
  });

  it("retains the accepted receipt across restart and rejects conflicts", () => {
    const input = {
      acceptanceKey: "child_intent_receipt-restart",
      intentId: "child_intent_receipt-restart",
      controllerSessionKey: "agent:main:main",
      requestDigest: "request-a",
      resolvedDigest: "resolved-a",
      gatewayRunId: "provider-receipt-restart",
      childSessionKey: "agent:main:subagent:receipt-restart",
    };
    const first = reserveGatewayAcceptanceReceipt(input);
    closeOpenClawStateDatabaseForTest();
    expect(readGatewayAcceptanceReceipt(input.acceptanceKey)).toMatchObject(first);
    expect(() => reserveGatewayAcceptanceReceipt({ ...input, requestDigest: "request-b" })).toThrow(
      "conflicts",
    );
    expect(
      markGatewayAcceptanceNotAccepted({
        acceptanceKey: input.acceptanceKey,
        gatewayRunId: input.gatewayRunId,
      }),
    ).toBe(true);
    expect(readGatewayAcceptanceReceipt(input.acceptanceKey)?.lifecycle).toBe("not_accepted");
  });

  it("linearizes one reservation across two independent sqlite processes", async () => {
    closeOpenClawStateDatabaseForTest();
    const ready = [path.join(stateDir, "ready-a"), path.join(stateDir, "ready-b")];
    const start = path.join(stateDir, "start");
    const script = `
      import fs from "node:fs";
      const store = await import("./src/agents/subagent-child-intent-store.sqlite.ts");
      const state = await import("./src/state/openclaw-state-db.ts");
      state.openOpenClawStateDatabase();
      const readyPath = __READY_PATH__;
      const startPath = __START_PATH__;
      const slot = __SLOT__;
      fs.writeFileSync(readyPath, "ready");
      while (!fs.existsSync(startPath)) await new Promise((resolve) => setTimeout(resolve, 5));
      const now = Date.now();
      const entry = { runId: "reservation-" + slot, childIntentKey: "child_intent_process-race", childIntentLookupKey: "child_intent_process-race", childIntentRequestDigest: "request-race", childIntentBehaviorDigest: "behavior-race", childSessionKey: "agent:main:subagent:process-race", controllerSessionKey: "agent:main:main", requesterSessionKey: "agent:main:main", requesterDisplayKey: "agent:main:main", task: "process race", cleanup: "keep", createdAt: now, reservationOwnerToken: "token-" + slot, reservationExpiresAt: now + 30000, execution: { status: "running", startedAt: now } };
      const winner = store.reserveSubagentRunAtomically(entry, 1);
      process.stdout.write(JSON.stringify({ owner: winner === null, winner: winner?.runId }));
    `;
    const children: ReturnType<typeof spawn>[] = [];
    const errors: string[] = [];
    const outputs: Array<() => string> = [];
    const spawnChild = (file: string, index: number) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script
            .replace("__READY_PATH__", JSON.stringify(file))
            .replace("__START_PATH__", JSON.stringify(start))
            .replace("__SLOT__", String(index)),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      errors[index] = "";
      let text = "";
      child.stdout?.on("data", (chunk) => (text += String(chunk)));
      child.stderr?.on("data", (chunk) => (errors[index] += String(chunk)));
      outputs[index] = () => text;
      return child;
    };
    try {
      children.push(spawnChild(ready[0], 0));
      await waitForFile(ready[0]);
      children.push(spawnChild(ready[1], 1));
      await waitForFile(ready[1]);
      fsSync.writeFileSync(start, "go");
      const exits = await Promise.all(
        children.map(async (child) => (await once(child, "close"))[0]),
      );
      expect(exits, errors.join(" | ")).toEqual([0, 0]);
      const results = outputs.map((read) => JSON.parse(read()));
      expect(results.filter((result) => result.owner)).toHaveLength(1);
      expect(results.filter((result) => result.winner)).toHaveLength(1);
      expect(
        reserveSubagentChildIntent({
          childIntentKey: "child_intent_process-race",
          childSessionKey: "agent:main:subagent:process-race",
          reservationRunId: "parent-retry",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "agent:main:main",
          task: "process race",
          cleanup: "keep",
          maxActiveChildren: 1,
          intentRequestDigest: "request-race",
          intentBehaviorDigest: "behavior-race",
        }).disposition,
      ).toBe("duplicate");
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode === null) {
            await once(child, "close");
          }
        }),
      );
      await Promise.all([...ready, start].map((file) => fs.rm(file, { force: true })));
    }
  });
});
