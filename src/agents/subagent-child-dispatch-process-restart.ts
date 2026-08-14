import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChildDispatchHarness,
  type ChildDispatchProcessHandle,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";

export type ChildDispatchProcessEvidence = {
  version: 1;
  scenario: string;
  status: "passed" | "failed";
  result?: Record<string, unknown>;
  barriers: readonly Record<string, unknown>[];
  modelRequests: number;
  physicalStarts: readonly Record<string, unknown>[];
  error?: string;
};

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
          model: { primary: "loopback-embedded/fake-model" },
          models: {
            "loopback-embedded/fake-model": { agentRuntime: { id: "openclaw" } },
          },
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

async function countLines(pathname: string): Promise<number> {
  return await fs
    .readFile(pathname, "utf8")
    .then((value) => value.split("\n").filter(Boolean).length)
    .catch(() => 0);
}

async function runRestartAt(point: string): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-restart-config-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  let gateway: ChildDispatchProcessHandle | undefined;
  let controller: ChildDispatchProcessHandle | undefined;
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port));
    gateway = harness.startGateway({ signer: true });
    const gatewayReady = await gateway.ready;
    controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await controller.ready;
    controller.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey: `gateway-restart-${point}`,
    });
    const sequence = [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
      "before.provider_start_cas",
      "receipt.started",
    ];
    for (const current of sequence) {
      if (current === point) {
        const held = await harness.next(current, 45_000);
        barriers.push(held);
        await gateway.terminate();
        await controller.terminate();
        break;
      }
      await allow(harness, current, barriers);
      if (current === "receipt.started") {
        await allow(harness, "provider.completed", barriers);
      }
    }
    const restartedGateway = harness.startGateway({ signer: true });
    const restartedReady = await restartedGateway.ready;
    const replay = harness.startController({ gatewayPort: Number(restartedReady.port) });
    await replay.ready;
    replay.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey: `gateway-restart-${point}`,
    });
    await allow(harness, "intent.reserved", barriers);
    const result = JSON.parse((await replay.waitFor("RESULT ")).slice(7)) as Record<
      string,
      unknown
    >;
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(result.status, "accepted");
    assert.equal(physicalStarts.length, 0);
    return {
      version: 1,
      scenario: `gateway-restart-${point}`,
      status: "passed",
      result,
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: `gateway-restart-${point}`,
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

async function runRestartAtCancelRequested(): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "child-dispatch-cancel-restart-config-"),
  );
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
    const operationKey = "gateway-restart-cancel-requested";
    controller.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey,
    });
    for (const point of [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
    ]) {
      await allow(harness, point, barriers);
    }
    const held = await harness.next("before.provider_start_cas", 45_000);
    barriers.push(held);
    controller.send({ op: "cancel" });
    const cancelResult = await harness.next("controller.cancel.result", 45_000);
    barriers.push(cancelResult);
    assert.equal(cancelResult.changed, true);
    assert.equal(cancelResult.receiptLifecycle, "cancel_requested");
    await gateway.terminate();
    await controller.terminate();

    const restartedGateway = harness.startGateway({ signer: true });
    const restartedReady = await restartedGateway.ready;
    const replay = harness.startController({ gatewayPort: Number(restartedReady.port) });
    await replay.ready;
    replay.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey,
    });
    await allow(harness, "intent.reserved", barriers);
    const terminal = await replay.waitForAny(["RESULT ", "ERROR "], 45_000);
    const result = terminal.startsWith("RESULT ")
      ? (JSON.parse(terminal.slice(7)) as Record<string, unknown>)
      : { status: "error", error: JSON.parse(terminal.slice(6)) };
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, 0);
    assert.notEqual(result.status, "accepted");
    return {
      version: 1,
      scenario: "gateway-restart-cancel-requested",
      status: "passed",
      result,
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "gateway-restart-cancel-requested",
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

export async function runGatewayRestartFenceBatch(): Promise<ChildDispatchProcessEvidence[]> {
  const points = [
    "receipt.preaccepted",
    "receipt.runnable",
    "receipt.dispatch_claimed",
    "before.provider_start_cas",
    "receipt.started",
  ];
  const results: ChildDispatchProcessEvidence[] = [];
  for (const point of points) {
    results.push(await runRestartAt(point));
  }
  results.push(await runRestartAtCancelRequested());
  return results;
}
