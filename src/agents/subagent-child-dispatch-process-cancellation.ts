import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
          model: { primary: "loopback-embedded/fake-model" },
          models: {
            "loopback-embedded/fake-model": { agentRuntime: { id: "openclaw" } },
            "fake-cli/fake-model": { agentRuntime: { id: "claude-cli" } },
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

async function countLines(pathname: string): Promise<number> {
  return await fs
    .readFile(pathname, "utf8")
    .then((value) => value.split("\n").filter(Boolean).length)
    .catch(() => 0);
}

async function waitBarrier(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  point: string,
  barriers: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const event = await harness.next(point, 45_000);
  barriers.push(event);
  return event;
}

async function allowBarrier(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  event: Record<string, unknown>,
): Promise<void> {
  await harness.allow(String(event.id));
}

async function drainPostCancelBarriers(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  barriers: Record<string, unknown>[],
): Promise<void> {
  const points = [
    "receipt.runnable",
    "receipt.dispatch_claimed",
    "gateway_accepted.persisted_before_register",
    "before.provider_start_cas",
    "receipt.started",
    "provider.failed",
    "provider.completed",
  ] as const;
  for (;;) {
    let event: Record<string, unknown>;
    try {
      event = await harness.nextAny(points, 10_000);
    } catch {
      return;
    }
    barriers.push(event);
    await allowBarrier(harness, event);
  }
}

async function runCancelAt(point: string): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-cancel-config-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  const cliAfterStart = point === "receipt.started";
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port));
    const gateway = harness.startGateway({ signer: true });
    const gatewayReady = await gateway.ready;
    const controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await controller.ready;
    controller.send({
      op: "spawn",
      governed: true,
      model: cliAfterStart ? "fake-cli/fake-model" : "loopback-embedded/fake-model",
      operationKey: `cancel-${point}`,
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
      const event = await waitBarrier(harness, current, barriers);
      if (current !== point) {
        await allowBarrier(harness, event);
        continue;
      }
      controller.send({ op: "cancel" });
      const cancelResult = await harness.next("controller.cancel.result", 45_000);
      barriers.push(cancelResult);
      assert.equal(cancelResult.changed, true);
      await allowBarrier(harness, event);
      if (current === "before.provider_start_cas") {
        await drainPostCancelBarriers(harness, barriers);
      } else if (current === "receipt.started") {
        const outcome = await harness.nextAny(["provider.failed", "provider.completed"], 45_000);
        barriers.push(outcome);
        await allowBarrier(harness, outcome);
      }
      await drainPostCancelBarriers(harness, barriers);
      break;
    }
    const terminal = await controller.waitForAny(["RESULT ", "ERROR "], 45_000);
    const result = terminal.startsWith("RESULT ")
      ? (JSON.parse(terminal.slice(7)) as Record<string, unknown>)
      : { status: "error", error: JSON.parse(terminal.slice(6)) };
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(result.status, "error");
    assert.equal(physicalStarts.length, cliAfterStart ? 1 : 0);
    return {
      version: 1,
      scenario: `cancel-${point}`,
      status: "passed",
      result,
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: `cancel-${point}`,
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

export async function runCancellationBatch(): Promise<ChildDispatchProcessEvidence[]> {
  const results: ChildDispatchProcessEvidence[] = [];
  for (const point of [
    "intent.reserved",
    "receipt.preaccepted",
    "receipt.runnable",
    "before.provider_start_cas",
    "receipt.started",
  ]) {
    results.push(await runCancelAt(point));
  }
  return results;
}
