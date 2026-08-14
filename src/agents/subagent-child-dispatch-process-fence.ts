import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createChildDispatchHarness,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";
import type { ChildDispatchProcessEvidence } from "./subagent-child-dispatch-process-restart.js";

async function writeConfig(file: string, workspace: string, modelPort: number): Promise<void> {
  const providerScript = fileURLToPath(
    new URL("./subagent-child-dispatch-process-provider.mjs", import.meta.url),
  );
  await fs.writeFile(
    file,
    `${JSON.stringify({
      gateway: { mode: "local", auth: { mode: "token", token: "child-dispatch-process-token" } },
      plugins: { enabled: false },
      models: {
        providers: {
          "loopback-embedded": {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            apiKey: "fixture",
            models: [
              {
                id: "fake-model",
                name: "fake-model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 256,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          workspace,
          model: { primary: "fake-cli/fake-model" },
          models: { "loopback-embedded/fake-model": { agentRuntime: { id: "openclaw" } } },
          cliBackends: {
            "fake-cli": {
              command: process.execPath,
              args: [providerScript],
              output: "text",
              input: "stdin",
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    })}\n`,
    "utf8",
  );
}

async function countLines(pathname: string): Promise<number> {
  return await fs
    .readFile(pathname, "utf8")
    .then((value) => value.split("\n").filter(Boolean).length)
    .catch(() => 0);
}

async function allow(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  point: string,
  barriers: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const event = await harness.next(point, 45_000);
  barriers.push(event);
  await harness.allow(String(event.id));
  return event;
}

async function replayAfterRestart(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  operationKey: string,
  barriers: Record<string, unknown>[],
  expectedRunId: string,
): Promise<Record<string, unknown>> {
  const gateway = harness.startGateway({ signer: true });
  const ready = await gateway.ready;
  const controller = harness.startController({ gatewayPort: Number(ready.port) });
  await controller.ready;
  controller.send({ op: "spawn", governed: true, model: "fake-cli/fake-model", operationKey });
  await allow(harness, "intent.reserved", barriers);
  const line = await controller.waitForAny(["RESULT ", "ERROR "], 45_000);
  await controller.close();
  const result = line.startsWith("RESULT ")
    ? (JSON.parse(line.slice(7)) as Record<string, unknown>)
    : { status: "error", error: JSON.parse(line.slice(6)) };
  assert.equal(result.status, "accepted");
  assert.equal(result.runId, expectedRunId);
  return result;
}

async function runUnknownCase(params: {
  label: string;
  killAfterPhysicalStart: boolean;
}): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `child-dispatch-unknown-${params.label}-`),
  );
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port));
    const gateway = harness.startGateway({
      signer: true,
      ...(params.killAfterPhysicalStart ? { providerFailure: "after-start" as const } : {}),
    });
    const gatewayReady = await gateway.ready;
    const controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await controller.ready;
    const operationKey = `unknown-${params.label}`;
    controller.send({ op: "spawn", governed: true, model: "fake-cli/fake-model", operationKey });
    for (const point of [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
    ]) {
      await allow(harness, point, barriers);
    }
    const startGate = await harness.next("before.provider_start_cas", 45_000);
    barriers.push(startGate);
    const expectedRunId = String(startGate.gatewayRunId);
    await harness.allow(String(startGate.id));
    if (params.killAfterPhysicalStart) {
      const physical = await harness.next("physical.start", 45_000);
      barriers.push(physical);
      const pid = Number(physical.pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The provider may have exited after its fsync record.
        }
      }
    }
    await gateway.terminate();
    await controller.terminate();
    const replay = await replayAfterRestart(harness, operationKey, barriers, expectedRunId);
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, params.killAfterPhysicalStart ? 1 : 0);
    return {
      version: 1,
      scenario: `unknown-restart-${params.label}`,
      status: "passed",
      result: { replay },
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: `unknown-restart-${params.label}`,
      status: "failed",
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts: await readPhysicalStarts(harness.physicalCounter),
      error: String(error),
    };
  } finally {
    await harness.close();
    await fs.rm(configRoot, { recursive: true, force: true });
  }
}

export async function runUnknownFenceBatch(): Promise<ChildDispatchProcessEvidence[]> {
  return [
    await runUnknownCase({ label: "pre-start", killAfterPhysicalStart: false }),
    await runUnknownCase({ label: "after-start", killAfterPhysicalStart: true }),
  ];
}

export async function runTerminalCompactionScenario(): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-compaction-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port));
    const gateway = harness.startGateway({ signer: true });
    const gatewayReady = await gateway.ready;
    const controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await controller.ready;
    const operationKey = "terminal-compaction-replay";
    controller.send({
      op: "spawn",
      governed: true,
      model: "fake-cli/fake-model",
      operationKey,
      releaseAfterResult: true,
    });
    for (const point of [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
      "before.provider_start_cas",
      "receipt.started",
      "provider.completed",
      "gateway_accepted.persisted_before_register",
    ]) {
      await allow(harness, point, barriers);
    }
    const firstLine = await controller.waitFor("RESULT ", 45_000);
    const first = JSON.parse(firstLine.slice(7)) as Record<string, unknown>;
    assert.equal(first.status, "accepted");
    const expectedRunId = String(
      barriers.find((event) => event.point === "before.provider_start_cas")?.gatewayRunId,
    );
    await controller.close();
    await gateway.close();
    const dbPath = path.join(harness.root, "state", "openclaw.sqlite");
    const database = new DatabaseSync(dbPath, { readOnly: true });
    const row = database
      .prepare(
        "SELECT state, generation, operation_key, gateway_receipt_id, registered_run_id, payload_json FROM subagent_child_intents WHERE operation_key = ?",
      )
      .get(operationKey) as Record<string, unknown> | undefined;
    database.close();
    assert.equal(row?.state, "terminal");
    assert.equal(typeof row?.generation, "number");
    assert.equal(row?.operation_key, operationKey);
    assert.equal(typeof row?.gateway_receipt_id, "string");
    assert.equal(typeof row?.registered_run_id, "string");
    assert.doesNotMatch(String(row?.payload_json), /process child probe/u);
    const replay = await replayAfterRestart(harness, operationKey, barriers, expectedRunId);
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, 1);
    return {
      version: 1,
      scenario: "terminal-compaction-replay-after-restart",
      status: "passed",
      result: { first, replay, terminalRow: row },
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "terminal-compaction-replay-after-restart",
      status: "failed",
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts: await readPhysicalStarts(harness.physicalCounter),
      error: String(error),
    };
  } finally {
    await harness.close();
    await fs.rm(configRoot, { recursive: true, force: true });
  }
}
