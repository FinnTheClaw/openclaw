import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createChildDispatchHarness,
  readPhysicalStarts,
} from "./subagent-child-dispatch-process-harness.js";

const processBoundary = process.platform === "win32" ? describe.skip : describe;

async function allowNext(
  harness: Awaited<ReturnType<typeof createChildDispatchHarness>>,
  point: string,
): Promise<Record<string, unknown>> {
  const event = await harness.next(point, 10_000);
  await harness.allow(String(event.id));
  return event;
}

async function writeConfig(params: {
  file: string;
  workspace: string;
  modelPort: number;
}): Promise<void> {
  const providerScript = fileURLToPath(
    new URL("./subagent-child-dispatch-process-provider.mjs", import.meta.url),
  );
  await fs.writeFile(
    params.file,
    `${JSON.stringify({
      gateway: { mode: "local", auth: { mode: "token", token: "child-dispatch-process-token" } },
      models: {
        providers: {
          "loopback-embedded": {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${params.modelPort}/v1`,
            apiKey: "fixture",
            models: [
              {
                id: "fake-model",
                name: "fake-model",
                reasoning: false,
                input: ["text"],
                contextWindow: 4096,
                maxTokens: 128,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          workspace: params.workspace,
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

processBoundary("child dispatch real process matrix", () => {
  it("runs governed embedded and CLI through separate controller/Gateway/provider processes", async () => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-config-"));
    const configPath = path.join(configRoot, "openclaw.json");
    const harness = await createChildDispatchHarness({ configPath });
    try {
      const model = harness.startModel();
      const modelReady = await model.ready;
      await writeConfig({
        file: configPath,
        workspace: harness.root,
        modelPort: Number(modelReady.port),
      });
      const gateway = harness.startGateway();
      const gatewayReady = await gateway.ready;
      const controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
      await controller.ready;
      controller.send({
        op: "spawn",
        governed: true,
        model: "loopback-embedded/fake-model",
        operationKey: "embedded-slot",
      });
      for (const point of [
        "receipt.preaccepted",
        "receipt.runnable",
        "receipt.dispatch_claimed",
        "before.provider_start_cas",
        "receipt.started",
        "gateway_accepted.persisted_before_register",
        "provider.completed",
      ]) {
        await allowNext(harness, point);
      }
      const embedded = await controller.waitFor("RESULT ");
      expect(JSON.parse(embedded.slice(7))).toMatchObject({ status: "ok" });
      await controller.close();
      const startsAfterEmbedded = await readPhysicalStarts(harness.physicalCounter);
      expect(startsAfterEmbedded).toHaveLength(0);
      const cli = harness.startController({ gatewayPort: Number(gatewayReady.port) });
      await cli.ready;
      cli.send({
        op: "spawn",
        governed: true,
        model: "fake-cli/fake-model",
        operationKey: "named-cli-a",
      });
      for (const point of [
        "receipt.preaccepted",
        "receipt.runnable",
        "receipt.dispatch_claimed",
        "before.provider_start_cas",
        "receipt.started",
        "gateway_accepted.persisted_before_register",
        "provider.completed",
      ]) {
        await allowNext(harness, point);
      }
      expect(JSON.parse((await cli.waitFor("RESULT ")).slice(7))).toMatchObject({ status: "ok" });
      await cli.close();
      expect(await readPhysicalStarts(harness.physicalCounter)).toHaveLength(1);
    } finally {
      await harness.close();
      await fs.rm(configRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects governed dispatch before provider work when Gateway has no signer", async () => {
    const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "child-dispatch-config-"));
    const configPath = path.join(configRoot, "openclaw.json");
    const harness = await createChildDispatchHarness({ configPath });
    try {
      const model = harness.startModel();
      const modelReady = await model.ready;
      await writeConfig({
        file: configPath,
        workspace: harness.root,
        modelPort: Number(modelReady.port),
      });
      const gateway = harness.startGateway({ signer: false });
      const gatewayReady = await gateway.ready;
      const controller = harness.startController({ gatewayPort: Number(gatewayReady.port) });
      await controller.ready;
      controller.send({
        op: "spawn",
        governed: true,
        model: "loopback-embedded/fake-model",
        operationKey: "missing-signer",
      });
      const result = JSON.parse((await controller.waitFor("RESULT ")).slice(7)) as {
        status?: string;
        error?: string;
      };
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/receipt authority|signer|governed/u);
      expect(await readPhysicalStarts(harness.physicalCounter)).toHaveLength(0);
      await controller.close();
    } finally {
      await harness.close();
      await fs.rm(configRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
