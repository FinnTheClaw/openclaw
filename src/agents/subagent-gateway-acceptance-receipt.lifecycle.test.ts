import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { reconcileSubagentChildIntent } from "./subagent-child-intent-reconciliation.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "./subagent-gateway-acceptance-receipt-runtime.js";
import {
  fencePriorGatewayAcceptanceReceipts,
  markGatewayAcceptanceAccepted,
  markGatewayAcceptanceCancelled,
  markGatewayAcceptanceDispatchClaimed,
  markGatewayAcceptanceNotAccepted,
  markGatewayAcceptanceRunnable,
  readGatewayAcceptanceReceipt,
  requestGatewayAcceptanceCancel,
  reserveGatewayAcceptanceReceipt,
} from "./subagent-gateway-acceptance-receipt-store.sqlite.js";

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fsSync.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error("receipt worker barrier timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("durable gateway acceptance receipts", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "NODE_ENV"]);
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-receipt-lifecycle-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("NODE_ENV", "test");
    installGatewayAcceptanceReceiptSigner({
      signingKey: "fixture-gateway-receipt-key",
      generation: "fixture-generation",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    clearGatewayAcceptanceReceiptSigner();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const input = () => ({
    acceptanceKey: "receipt-lifecycle-key",
    intentId: "intent-lifecycle-key",
    controllerSessionKey: "agent:main:main",
    requestDigest: "request-lifecycle",
    resolvedDigest: "resolved-lifecycle",
    gatewayRunId: "gateway-run-lifecycle",
    childSessionKey: "agent:main:subagent:lifecycle",
    acceptanceEpoch: "gateway-epoch-1",
  });

  it("keeps preacceptance fenced across restart and permits only a durable safe retry", () => {
    const first = reserveGatewayAcceptanceReceipt(input());
    expect(first.lifecycle).toBe("preaccepted");
    expect(first.acceptedAt).toBeUndefined();
    expect(first.proof.signature).toMatch(/^[a-f0-9]{64}$/u);
    closeOpenClawStateDatabaseForTest();
    expect(readGatewayAcceptanceReceipt(first.acceptanceKey)?.lifecycle).toBe("preaccepted");
    expect(reserveGatewayAcceptanceReceipt(input()).receiptGeneration).toBe(0);
    expect(markGatewayAcceptanceRunnable(input())).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(input())).toBe(true);
    expect(markGatewayAcceptanceAccepted(input())).toBe(true);
    expect(requestGatewayAcceptanceCancel(input())).toBe(true);
    expect(markGatewayAcceptanceCancelled(input())).toBe(true);
    expect(markGatewayAcceptanceNotAccepted(input())).toBe(false);

    expect(() =>
      reserveGatewayAcceptanceReceipt({
        ...input(),
        gatewayRunId: "gateway-run-lifecycle-retry",
      }),
    ).toThrow("conflicts");

    closeOpenClawStateDatabaseForTest();
    const safe = reserveGatewayAcceptanceReceipt({
      ...input(),
      acceptanceKey: "receipt-safe-retry",
      intentId: "intent-safe-retry",
    });
    expect(markGatewayAcceptanceNotAccepted(safe)).toBe(true);
    const next = reserveGatewayAcceptanceReceipt({
      ...input(),
      acceptanceKey: "receipt-safe-retry",
      intentId: "intent-safe-retry",
      gatewayRunId: "gateway-safe-retry-2",
    });
    expect(next.receiptGeneration).toBe(1);
    expect(next.proof.signature).not.toBe(safe.proof.signature);
  });

  it("rejects envelope and signature tampering before exposing a receipt", () => {
    const receipt = reserveGatewayAcceptanceReceipt(input());
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(
        "UPDATE subagent_gateway_acceptance_receipts SET envelope_json = ? WHERE acceptance_key = ?",
      ).run(JSON.stringify({ ...receipt.envelope, gatewayRunId: "forged" }), receipt.acceptanceKey);
    });
    expect(() => readGatewayAcceptanceReceipt(receipt.acceptanceKey)).toThrow("RECEIPT_INVALID");
  });

  it("terminalizes a durable cancellation before the dispatch handoff", () => {
    const reserved = reserveGatewayAcceptanceReceipt({
      ...input(),
      acceptanceKey: "receipt-cancel-before-handoff",
      intentId: "intent-cancel-before-handoff",
      gatewayRunId: "gateway-cancel-before-handoff",
    });
    expect(markGatewayAcceptanceRunnable(reserved)).toBe(true);
    expect(requestGatewayAcceptanceCancel(reserved)).toBe(true);
    expect(markGatewayAcceptanceCancelled(reserved)).toBe(true);
    expect(readGatewayAcceptanceReceipt(reserved.acceptanceKey)?.lifecycle).toBe("cancelled");
    expect(markGatewayAcceptanceDispatchClaimed(reserved)).toBe(false);
  });

  it("fences an accepted handoff from a restarted gateway without retry", () => {
    const reserved = reserveGatewayAcceptanceReceipt({
      ...input(),
      acceptanceKey: "receipt-prior-epoch",
      intentId: "intent-prior-epoch",
      gatewayRunId: "gateway-prior-epoch",
      acceptanceEpoch: "gateway-old-epoch",
    });
    expect(markGatewayAcceptanceRunnable(reserved)).toBe(true);
    expect(markGatewayAcceptanceDispatchClaimed(reserved)).toBe(true);
    expect(markGatewayAcceptanceAccepted(reserved)).toBe(true);
    expect(fencePriorGatewayAcceptanceReceipts("gateway-new-epoch")).toBe(1);
    expect(readGatewayAcceptanceReceipt(reserved.acceptanceKey)).toMatchObject({
      lifecycle: "unknown",
      gatewayRunId: "gateway-prior-epoch",
    });
    expect(
      reserveGatewayAcceptanceReceipt({
        ...input(),
        acceptanceKey: reserved.acceptanceKey,
        intentId: reserved.intentId,
        gatewayRunId: reserved.gatewayRunId,
        acceptanceEpoch: "gateway-new-epoch",
      }),
    ).toMatchObject({ lifecycle: "unknown" });
  });

  it.each([
    ["preaccepted", []],
    ["runnable", ["runnable"]],
    ["dispatch_claimed", ["runnable", "dispatch_claimed"]],
  ] as const)("fences a prior-epoch %s handoff before acceptance", (stage, transitions) => {
    const reserved = reserveGatewayAcceptanceReceipt({
      ...input(),
      acceptanceKey: `receipt-prior-${stage}`,
      intentId: `intent-prior-${stage}`,
      gatewayRunId: `gateway-prior-${stage}`,
      acceptanceEpoch: "gateway-old-epoch",
    });
    for (const transition of transitions) {
      expect(
        transition === "runnable"
          ? markGatewayAcceptanceRunnable(reserved)
          : markGatewayAcceptanceDispatchClaimed(reserved),
      ).toBe(true);
    }
    expect(fencePriorGatewayAcceptanceReceipts("gateway-new-epoch")).toBe(1);
    expect(readGatewayAcceptanceReceipt(reserved.acceptanceKey)?.lifecycle).toBe("unknown");
  });

  it("does not use agent.wait to prove a durable receipt was not accepted", async () => {
    const waitForProvider = vi.fn(async () => ({ providerStarted: false, status: "timeout" }));
    const reservation = {
      disposition: "duplicate" as const,
      childIntentKey: "intent-reconcile",
      childSessionKey: "agent:main:subagent:reconcile",
      reservationRunId: "reservation-placeholder",
      existingRunId: "reservation-placeholder",
      reservationToken: "token",
      dispatchState: "dispatching" as const,
      durableReceiptRequired: true,
    };
    await expect(
      reconcileSubagentChildIntent({
        reservation,
        waitForProvider,
        lookupAcceptance: () => undefined,
        adopt: () => false,
        abandon: () => false,
      }),
    ).resolves.toBe("duplicate");
    expect(waitForProvider).not.toHaveBeenCalled();
  });

  it("linearizes physical dispatch across two independent gateway processes", async () => {
    closeOpenClawStateDatabaseForTest();
    const ready = [path.join(stateDir, "ready-a"), path.join(stateDir, "ready-b")];
    const start = path.join(stateDir, "start");
    const counter = path.join(stateDir, "physical-dispatches");
    const script = `
      import fs from "node:fs";
      const runtime = await import("./src/agents/subagent-gateway-acceptance-receipt-runtime.ts");
      runtime.installGatewayAcceptanceReceiptSigner({ signingKey: "fixture-gateway-receipt-key", generation: "fixture-generation" });
      const store = await import("./src/agents/subagent-gateway-acceptance-receipt-store.sqlite.ts");
      const state = await import("./src/state/openclaw-state-db.ts");
      state.openOpenClawStateDatabase();
      fs.writeFileSync(__READY__, "ready");
      while (!fs.existsSync(__START__)) await new Promise((resolve) => setTimeout(resolve, 5));
      const input = { acceptanceKey: "cross-process-receipt", intentId: "cross-process-intent", controllerSessionKey: "agent:main:main", requestDigest: "cross-request", resolvedDigest: "cross-resolved", gatewayRunId: "cross-gateway-run", childSessionKey: "agent:main:subagent:cross-process", acceptanceEpoch: "epoch-cross" };
      store.reserveGatewayAcceptanceReceipt(input);
      if (store.markGatewayAcceptanceRunnable(input) && store.markGatewayAcceptanceDispatchClaimed(input)) {
        fs.appendFileSync(__COUNTER__, "dispatch\\n");
        store.markGatewayAcceptanceAccepted(input);
        process.stdout.write("winner");
      } else {
        process.stdout.write("loser");
      }
    `
      .replace("__READY__", JSON.stringify(ready[0]))
      .replace("__START__", JSON.stringify(start))
      .replace("__COUNTER__", JSON.stringify(counter));
    const children: ReturnType<typeof spawn>[] = [];
    const outputs: string[] = [];
    const errors: string[] = [];
    try {
      for (const [index, readyPath] of ready.entries()) {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script.replace(JSON.stringify(ready[0]), JSON.stringify(readyPath)),
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        outputs[index] = "";
        errors[index] = "";
        child.stdout?.on("data", (chunk) => (outputs[index] += String(chunk)));
        child.stderr?.on("data", (chunk) => (errors[index] += String(chunk)));
        children.push(child);
        await waitForFile(readyPath);
      }
      fsSync.writeFileSync(start, "go");
      const exits = await Promise.all(
        children.map(async (child) => (await once(child, "close"))[0]),
      );
      expect(exits, errors.join(" | ")).toEqual([0, 0]);
      expect(outputs.filter((value) => value === "winner")).toHaveLength(1);
      expect(fsSync.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
      expect(readGatewayAcceptanceReceipt("cross-process-receipt")?.lifecycle).toBe("accepted");
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
      await Promise.all(
        children.map(async (child) => (child.exitCode === null ? once(child, "close") : undefined)),
      );
      await Promise.all([...ready, start, counter].map((file) => fs.rm(file, { force: true })));
    }
  });

  it("lets a restarted controller adopt the exact accepted gateway run once", async () => {
    closeOpenClawStateDatabaseForTest();
    const counter = path.join(stateDir, "accepted-dispatches");
    const adoption = path.join(stateDir, "adopted-run");
    const script = `
      import fs from "node:fs";
      const role = process.env.RECEIPT_ROLE;
      const runtime = await import("./src/agents/subagent-gateway-acceptance-receipt-runtime.ts");
      runtime.installGatewayAcceptanceReceiptSigner({ signingKey: "fixture-gateway-receipt-key", generation: "fixture-generation" });
      const store = await import("./src/agents/subagent-gateway-acceptance-receipt-store.sqlite.ts");
      const state = await import("./src/state/openclaw-state-db.ts");
      state.openOpenClawStateDatabase();
      const input = { acceptanceKey: "controller-crash-receipt", intentId: "controller-crash-intent", controllerSessionKey: "agent:main:main", requestDigest: "controller-crash-request", resolvedDigest: "controller-crash-resolved", gatewayRunId: "authoritative-gateway-run", childSessionKey: "agent:main:subagent:controller-crash", acceptanceEpoch: "gateway-epoch-stable" };
      if (role === "gateway") {
        const receipt = store.reserveGatewayAcceptanceReceipt(input);
        if (!store.markGatewayAcceptanceRunnable(receipt) || !store.markGatewayAcceptanceDispatchClaimed(receipt)) process.exit(2);
        fs.appendFileSync(__COUNTER__, "dispatch\\n");
        if (!store.markGatewayAcceptanceAccepted(input)) process.exit(3);
      } else {
        const receipt = store.readGatewayAcceptanceReceipt(input.acceptanceKey);
        if (!receipt || receipt.lifecycle !== "accepted" || receipt.gatewayRunId !== input.gatewayRunId) process.exit(4);
        fs.writeFileSync(__ADOPTION__, receipt.gatewayRunId);
      }
    `
      .replace("__COUNTER__", JSON.stringify(counter))
      .replace("__ADOPTION__", JSON.stringify(adoption));
    const run = async (role: "gateway" | "controller") => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            NODE_ENV: "test",
            RECEIPT_ROLE: role,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      const [code] = (await once(child, "close")) as [number | null];
      expect(code, stderr).toBe(0);
    };
    await run("gateway");
    await run("controller");
    expect(fsSync.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fsSync.readFileSync(adoption, "utf8")).toBe("authoritative-gateway-run");
    expect(readGatewayAcceptanceReceipt("controller-crash-receipt")?.lifecycle).toBe("accepted");
    await Promise.all([fs.rm(counter, { force: true }), fs.rm(adoption, { force: true })]);
  });
});
