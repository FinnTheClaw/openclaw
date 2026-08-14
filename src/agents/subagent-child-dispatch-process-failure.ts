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
import type { ChildDispatchProcessEvidence } from "./subagent-child-dispatch-process-restart.js";

async function writeConfig(
  file: string,
  workspace: string,
  modelPort: number,
  primaryModel = "loopback-embedded/fake-model",
): Promise<void> {
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
          model: { primary: primaryModel },
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

async function readResult(handle: ChildDispatchProcessHandle): Promise<Record<string, unknown>> {
  const line = await handle.waitForAny(["RESULT ", "ERROR "], 45_000);
  return line.startsWith("RESULT ")
    ? (JSON.parse(line.slice(7)) as Record<string, unknown>)
    : { status: "error", error: JSON.parse(line.slice(6)) };
}

function terminatePhysicalProcess(event: Record<string, unknown>): void {
  const pid = Number(event.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("physical provider event did not include a valid pid");
  }
  process.kill(pid, "SIGKILL");
}

async function allowSuccessfulRetry(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  controller: ChildDispatchProcessHandle,
  operationKey: string,
  barriers: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  controller.send({
    op: "spawn",
    governed: true,
    model: "loopback-embedded/fake-model",
    operationKey,
  });
  await allow(harness, "intent.reserved", barriers);
  for (const point of [
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
  return await readResult(controller);
}

export async function runFailedBeforeStartScenario(): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "child-dispatch-failed-before-start-"),
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
    const first = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await first.ready;
    const operationKey = "failed-before-start-successor";
    first.send({
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
    const startGate = await harness.next("before.provider_start_cas", 45_000);
    barriers.push(startGate);
    await harness.deny(String(startGate.id));
    await allow(harness, "gateway_accepted.persisted_before_register", barriers);
    await allow(harness, "provider.failed", barriers);
    const firstResult = await readResult(first);
    assert.equal(firstResult.status, "accepted");

    const retry = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await retry.ready;
    const retryResult = await allowSuccessfulRetry(harness, retry, operationKey, barriers);
    assert.equal(retryResult.status, "accepted");
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, 0);
    return {
      version: 1,
      scenario: "failed-before-start-successor",
      status: "passed",
      result: { first: firstResult, retry: retryResult },
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "failed-before-start-successor",
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

export async function runFailedAfterStartScenario(): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-failed-after-start-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port), "fake-cli/fake-model");
    const gateway = harness.startGateway({ signer: true, providerFailure: "after-start" });
    const gatewayReady = await gateway.ready;
    const first = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await first.ready;
    const operationKey = "failed-after-start-fenced";
    first.send({ op: "spawn", governed: true, model: "fake-cli/fake-model", operationKey });
    for (const point of [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
      "before.provider_start_cas",
    ]) {
      await allow(harness, point, barriers);
    }
    const physical = await harness.next("physical.start", 45_000);
    barriers.push(physical);
    terminatePhysicalProcess(physical);
    await allow(harness, "gateway_accepted.persisted_before_register", barriers);
    await allow(harness, "receipt.started", barriers);
    await allow(harness, "provider.failed", barriers);
    const firstResult = await readResult(first);
    assert.equal((await readPhysicalStarts(harness.physicalCounter)).length, 1);

    const replay = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await replay.ready;
    replay.send({ op: "spawn", governed: true, model: "fake-cli/fake-model", operationKey });
    await allow(harness, "intent.reserved", barriers);
    const replayResult = await readResult(replay);
    assert.notEqual(replayResult.status, "accepted");
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, 1);
    return {
      version: 1,
      scenario: "failed-after-start-fenced",
      status: "passed",
      result: { first: firstResult, replay: replayResult },
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "failed-after-start-fenced",
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
