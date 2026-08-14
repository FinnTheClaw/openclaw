import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildDispatchScenario } from "./subagent-child-dispatch-process-base.js";
import { runCancellationBatch } from "./subagent-child-dispatch-process-cancellation.js";
import {
  runFailedAfterStartScenario,
  runFailedBeforeStartScenario,
} from "./subagent-child-dispatch-process-failure.js";
import {
  runTerminalCompactionScenario,
  runUnknownFenceBatch,
} from "./subagent-child-dispatch-process-fence.js";
import {
  type ChildDispatchProcessHandle,
  createChildDispatchHarness,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";
import {
  runGatewayRestartFenceBatch,
  type ChildDispatchProcessEvidence as Evidence,
} from "./subagent-child-dispatch-process-restart.js";

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
        list: [{ id: "main", default: true }, { id: "other" }],
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

async function countLines(pathname: string): Promise<number> {
  return await fs
    .readFile(pathname, "utf8")
    .then((value) => value.split("\n").filter(Boolean).length)
    .catch(() => 0);
}

async function runGovernedEmbeddedSpawn(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  controller: ChildDispatchProcessHandle,
  operationKey: string,
  barriers: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  controller.send({
    op: "spawn",
    governed: true,
    model: "loopback-embedded/fake-model",
    operationKey,
    ...extra,
  });
  for (const point of [
    "intent.reserved",
    "receipt.preaccepted",
    "receipt.runnable",
    "receipt.dispatch_claimed",
    "before.provider_start_cas",
    "receipt.started",
    "provider.completed",
  ]) {
    await allowNext(harness, point, barriers);
  }
  await allowNext(harness, "gateway_accepted.persisted_before_register", barriers);
  return JSON.parse((await controller.waitFor("RESULT ")).slice(7)) as Record<string, unknown>;
}

async function runRecoveredEmbeddedSpawn(
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
  await allowNext(harness, "intent.reserved", barriers);
  return JSON.parse((await controller.waitFor("RESULT ")).slice(7)) as Record<string, unknown>;
}

async function runCrashAfterAcceptanceScenario(): Promise<Evidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-crash-config-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  let first: ChildDispatchProcessHandle | undefined;
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(
      configPath,
      harness.root,
      Number(modelReady.port),
      "loopback-embedded/fake-model",
    );
    const gateway = harness.startGateway({ signer: true });
    const gatewayReady = await gateway.ready;
    first = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await first.ready;
    first.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey: "crash-before-register",
    });
    for (const point of [
      "intent.reserved",
      "receipt.preaccepted",
      "receipt.runnable",
      "receipt.dispatch_claimed",
      "before.provider_start_cas",
      "receipt.started",
      "provider.completed",
    ]) {
      await allowNext(harness, point, barriers);
    }
    const accepted = await harness.next("gateway_accepted.persisted_before_register", 45_000);
    barriers.push(accepted);
    await first.terminate();
    const recovery = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await recovery.ready;
    const recovered = await runRecoveredEmbeddedSpawn(
      harness,
      recovery,
      "crash-before-register",
      barriers,
    );
    const physicalStarts = await readPhysicalStarts(harness.physicalCounter);
    assert.equal(recovered.status, "accepted");
    assert.equal(recovered.runId, accepted.gatewayRunId);
    assert.equal(physicalStarts.length, 0);
    return {
      version: 1,
      scenario: "controller-crash-after-gateway-acceptance",
      status: "passed",
      result: recovered,
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts,
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "controller-crash-after-gateway-acceptance",
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

async function runNamedIdentityScenario(): Promise<Evidence> {
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-identity-config-"));
  const configPath = path.join(configRoot, "openclaw.json");
  const harness = await createChildDispatchHarness({ configPath });
  const barriers: Record<string, unknown>[] = [];
  try {
    const model = harness.startModel();
    const modelReady = await model.ready;
    await writeConfig(
      configPath,
      harness.root,
      Number(modelReady.port),
      "loopback-embedded/fake-model",
    );
    const gateway = harness.startGateway({ signer: true });
    const gatewayReady = await gateway.ready;
    const firstController = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await firstController.ready;
    const first = await runGovernedEmbeddedSpawn(
      harness,
      firstController,
      "named-slot-a",
      barriers,
    );
    const secondController = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await secondController.ready;
    const second = await runGovernedEmbeddedSpawn(
      harness,
      secondController,
      "named-slot-b",
      barriers,
    );
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    assert.notEqual(first.childSessionKey, second.childSessionKey);
    assert.notEqual(first.runId, second.runId);

    const modelMismatch = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await modelMismatch.ready;
    modelMismatch.send({
      op: "spawn",
      governed: true,
      model: "fake-cli/fake-model",
      operationKey: "named-slot-a",
    });
    const mismatch = JSON.parse((await modelMismatch.waitFor("RESULT ")).slice(7)) as Record<
      string,
      unknown
    >;
    assert.match(String(mismatch.error), /conflict|binding|digest|operation/u);

    const targetMismatch = harness.startController({ gatewayPort: Number(gatewayReady.port) });
    await targetMismatch.ready;
    targetMismatch.send({
      op: "spawn",
      governed: true,
      model: "loopback-embedded/fake-model",
      operationKey: "named-slot-a",
      agentId: "other",
    });
    const targetError = JSON.parse((await targetMismatch.waitFor("RESULT ")).slice(7)) as Record<
      string,
      unknown
    >;
    assert.match(
      String(targetError.error),
      /conflict|binding|digest|operation|not allowed|target/u,
    );
    assert.equal((await readPhysicalStarts(harness.physicalCounter)).length, 0);
    return {
      version: 1,
      scenario: "named-slots-and-binding-conflicts",
      status: "passed",
      result: {
        firstRunId: first.runId,
        secondRunId: second.runId,
        modelMismatch: mismatch.error,
        targetMismatch: targetError.error,
      },
      barriers,
      modelRequests: await countLines(harness.modelCounter),
      physicalStarts: await readPhysicalStarts(harness.physicalCounter),
    };
  } catch (error) {
    return {
      version: 1,
      scenario: "named-slots-and-binding-conflicts",
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
  const results: Evidence[] = [];
  if (requestedScenario === "controller-crash-after-gateway-acceptance") {
    results.push(await runCrashAfterAcceptanceScenario());
  } else if (requestedScenario === "named-slots-and-binding-conflicts") {
    results.push(await runNamedIdentityScenario());
  } else if (requestedScenario === "gateway-restart-fence") {
    results.push(...(await runGatewayRestartFenceBatch()));
  } else if (requestedScenario === "cancellation-matrix") {
    results.push(...(await runCancellationBatch()));
  } else if (requestedScenario === "failure-matrix") {
    results.push(await runFailedBeforeStartScenario());
    results.push(await runFailedAfterStartScenario());
  } else if (requestedScenario === "unknown-fence") {
    results.push(...(await runUnknownFenceBatch()));
  } else if (requestedScenario === "terminal-compaction") {
    results.push(await runTerminalCompactionScenario());
  } else if (selectedScenarios.length === 0) {
    throw new Error(`unknown child-dispatch scenario: ${requestedScenario}`);
  } else {
    for (const scenario of selectedScenarios) {
      results.push(await runChildDispatchScenario(scenario, writeConfig));
    }
    if (!requestedScenario) {
      results.push(await runCrashAfterAcceptanceScenario());
      results.push(await runNamedIdentityScenario());
    }
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
