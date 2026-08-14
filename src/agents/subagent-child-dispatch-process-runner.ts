import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChildDispatchProcessHandle,
  createChildDispatchHarness,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";

type Evidence = {
  version: 1;
  scenario: string;
  status: "passed" | "failed";
  result?: Record<string, unknown>;
  barriers: readonly Record<string, unknown>[];
  modelRequests: number;
  physicalStarts: readonly Record<string, unknown>[];
  error?: string;
};

async function writeConfig(
  file: string,
  workspace: string,
  modelPort: number,
  primaryModel: string,
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

async function runScenario(params: {
  scenario: string;
  model: "loopback-embedded/fake-model" | "fake-cli/fake-model";
  governed: boolean;
  signer: boolean;
  operationKey: string;
  expectedPhysicalStarts: number;
}): Promise<Evidence> {
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
    const modelRequests = await fs
      .readFile(harness.modelCounter, "utf8")
      .then((value) => value.split("\n").filter(Boolean).length)
      .catch(() => 0);
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    return {
      version: 1,
      scenario: params.scenario,
      status: "failed",
      ...(result ? { result } : {}),
      barriers,
      modelRequests,
      physicalStarts,
      error: String(error),
    };
  } finally {
    await harness.close();
    await fs.rm(configRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const evidencePath =
    process.env.CHILD_DISPATCH_EVIDENCE ?? path.resolve("child-dispatch-evidence.json");
  const scenarios = [
    {
      scenario: "governed-embedded",
      model: "loopback-embedded/fake-model" as const,
      governed: true,
      signer: true,
      operationKey: "matrix-embedded",
      expectedPhysicalStarts: 0,
    },
    {
      scenario: "governed-cli",
      model: "fake-cli/fake-model" as const,
      governed: true,
      signer: true,
      operationKey: "matrix-cli",
      expectedPhysicalStarts: 1,
    },
    {
      scenario: "off-embedded-no-signer",
      model: "loopback-embedded/fake-model" as const,
      governed: false,
      signer: false,
      operationKey: "matrix-off-embedded",
      expectedPhysicalStarts: 0,
    },
    {
      scenario: "off-cli-no-signer",
      model: "fake-cli/fake-model" as const,
      governed: false,
      signer: false,
      operationKey: "matrix-off-cli",
      expectedPhysicalStarts: 1,
    },
    {
      scenario: "governed-missing-signer",
      model: "loopback-embedded/fake-model" as const,
      governed: true,
      signer: false,
      operationKey: "matrix-missing-signer",
      expectedPhysicalStarts: 0,
    },
  ];
  const requestedScenario = process.env.CHILD_DISPATCH_SCENARIO;
  const selectedScenarios = requestedScenario
    ? scenarios.filter((scenario) => scenario.scenario === requestedScenario)
    : scenarios;
  if (selectedScenarios.length === 0) {
    throw new Error(`unknown child-dispatch scenario: ${requestedScenario}`);
  }
  const results: Evidence[] = [];
  for (const scenario of selectedScenarios) {
    results.push(await runScenario(scenario));
  }
  const evidence = {
    version: 1 as const,
    status: results.every((item) => item.status === "passed")
      ? ("passed" as const)
      : ("failed" as const),
    scenarios: results,
  };
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `EVIDENCE ${JSON.stringify({ path: evidencePath, status: evidence.status })}\n`,
  );
  if (evidence.status !== "passed") {
    const failure = results.find((item) => item.status === "failed");
    throw new Error(failure?.error ?? "standalone process runner failed");
  }
}

await main();
