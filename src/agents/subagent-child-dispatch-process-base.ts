import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ChildDispatchProcessHandle,
  createChildDispatchHarness,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";
import type { ChildDispatchProcessEvidence } from "./subagent-child-dispatch-process-restart.js";

type Scenario = {
  scenario: string;
  model: "loopback-embedded/fake-model" | "fake-cli/fake-model";
  governed: boolean;
  signer: boolean;
  operationKey: string;
  expectedPhysicalStarts: number;
};

async function allowNext(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  point: string,
  barriers: Record<string, unknown>[],
): Promise<void> {
  const event = await harness.next(point, 45_000);
  barriers.push(event);
  await harness.allow(String(event.id));
}

async function allowNextAny(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  points: readonly string[],
  barriers: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const event = await harness.nextAny(points, 45_000);
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

export async function runChildDispatchScenario(
  params: Scenario,
  writeConfig: (
    file: string,
    workspace: string,
    modelPort: number,
    primaryModel: string,
  ) => Promise<void>,
): Promise<ChildDispatchProcessEvidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-runner-config-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  let result: Record<string, unknown> | undefined;
  let controller: ChildDispatchProcessHandle | undefined;
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(configPath, harness.root, Number(modelReady.port), params.model);
    const gateway = harness.startGateway({ signer: params.signer });
    const gatewayReady = await gateway.ready;
    controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await controller.ready;
    controller.send({
      op: "spawn",
      governed: params.governed,
      model: params.model,
      operationKey: params.operationKey,
    });
    await allowNext(harness, "intent.reserved", barriers);
    if (params.governed && params.signer) {
      for (const point of [
        "receipt.preaccepted",
        "receipt.runnable",
        "gateway_accepted.persisted_before_register",
        "receipt.dispatch_claimed",
      ]) {
        await allowNext(harness, point, barriers);
      }
      const start =
        params.model === "fake-cli/fake-model"
          ? await allowNextAny(harness, ["before.provider_start_cas", "provider.failed"], barriers)
          : await allowNextAny(harness, ["before.provider_start_cas"], barriers);
      if (start.point === "provider.failed") {
        throw new Error("CLI provider failed before start authorization");
      }
      for (const point of ["receipt.started", "provider.completed"]) {
        await allowNext(harness, point, barriers);
      }
    } else if (!params.governed) {
      await allowNext(harness, "gateway_accepted.persisted_before_register", barriers);
      if (params.model === "fake-cli/fake-model") {
        const physical = await harness.next("physical.start", 45_000);
        barriers.push(physical);
      }
    }
    const controllerResult = await harness.next("controller.spawn.result", 10_000);
    result = controllerResult as Record<string, unknown>;
    assert.equal(result.status, params.governed && !params.signer ? "error" : "accepted");
    const modelRequests = await countLines(harness.modelCounter);
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(physicalStarts.length, params.expectedPhysicalStarts);
    if (params.model === "fake-cli/fake-model" && params.governed && params.signer) {
      const started = barriers.find((event) => event.point === "receipt.started");
      assert.equal(started?.provider, "fake-cli");
      assert.equal(result.resolvedProvider, "fake-cli");
      assert.equal(result.resolvedModel, "fake-cli/fake-model");
      assert.equal(physicalStarts[0]?.kind, "cli-start");
    }
    if (params.model === "loopback-embedded/fake-model" && params.governed && params.signer) {
      assert.ok(modelRequests >= 1);
    }
    return {
      version: 1,
      scenario: params.scenario,
      status: "passed",
      result,
      barriers,
      modelRequests,
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: params.scenario,
      status: "failed",
      ...(result ? { result } : {}),
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
