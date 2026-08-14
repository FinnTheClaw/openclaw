import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

type GatewayReady = { gatewayPort: number };
type ModelReady = { modelPort: number };

type LineProcess<T> = {
  child: ChildProcess;
  ready: Promise<T>;
  waitFor: (prefix: string) => Promise<string>;
  close: () => Promise<void>;
};

function startModelProcess(params: { counterPath: string }): LineProcess<ModelReady> {
  const script = `
    import fs from "node:fs";
    import http from "node:http";
    import { createInterface } from "node:readline";
    const modelServer = http.createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
        return;
      }
      request.resume();
      request.once("end", () => {
        fs.appendFileSync(process.env.MODEL_COUNTER, "request\\n");
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write("data: " + JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { role: "assistant", content: "EMBEDDED-PROBE" }, finish_reason: null }] }) + "\\n\\n");
        response.write("data: " + JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + "\\n\\n");
        response.end("data: [DONE]\\n\\n");
      });
    });
    await new Promise((resolve, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", resolve);
    });
    const address = modelServer.address();
    if (!address || typeof address === "string") throw new Error("model server address missing");
    process.stdout.write("READY " + JSON.stringify({ modelPort: address.port }) + "\\n");
    const control = createInterface({ input: process.stdin });
    control.on("line", async (line) => {
      if (line !== "CLOSE") return;
      await new Promise((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
      process.stdout.write("CLOSED\\n");
      control.close();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      MODEL_COUNTER: params.counterPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const waitFor = (prefix: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        if (!line.startsWith(prefix)) {
          return;
        }
        cleanup();
        resolve(line);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`model process exited ${String(code)}: ${stderr.join("")}`));
      };
      const cleanup = () => {
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      lines.on("line", onLine);
      child.once("exit", onExit);
    });
  return {
    child,
    ready: waitFor("READY ").then((line) => JSON.parse(line.slice(6)) as ModelReady),
    waitFor,
    close: async () => {
      child.stdin?.write("CLOSE\\n");
      await waitFor("CLOSED");
      await once(child, "close");
      lines.close();
    },
  };
}

function startGatewayProcess(params: {
  configPath: string;
  stateDir: string;
  token: string;
  physicalCounter: string;
}): LineProcess<GatewayReady> {
  const script = `
    import { createInterface } from "node:readline";
    import { startGatewayServer } from "./src/gateway/server.ts";
    const gateway = await startGatewayServer(0, {
      bind: "loopback",
      host: "127.0.0.1",
      auth: { mode: "token", token: process.env.GATEWAY_TOKEN },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      sidecarStartup: "defer",
    });
    process.stdout.write("READY " + JSON.stringify({ gatewayPort: gateway.port }) + "\\n");
    const control = createInterface({ input: process.stdin });
    control.on("line", async (line) => {
      if (line !== "CLOSE") {
        return;
      }
      await gateway.close({ reason: "process-boundary-test" });
      process.stdout.write("CLOSED\\n");
      control.close();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_GATEWAY_TOKEN: params.token,
      GATEWAY_TOKEN: params.token,
      PHYSICAL_COUNTER: params.physicalCounter,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const waitFor = (prefix: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        if (!line.startsWith(prefix)) {
          return;
        }
        cleanup();
        resolve(line);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`gateway process exited ${String(code)}: ${stderr.join("")}`));
      };
      const cleanup = () => {
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      lines.on("line", onLine);
      child.once("exit", onExit);
    });
  const ready = waitFor("READY ").then(
    (line) => JSON.parse(line.slice("READY ".length)) as GatewayReady,
  );
  return {
    child,
    ready,
    waitFor,
    close: async () => {
      child.stdin?.write("CLOSE\\n");
      await waitFor("CLOSED");
      await once(child, "close");
      lines.close();
    },
  };
}

type ControllerResult = {
  status: string;
  childSessionKey?: string;
  runId?: string;
  error?: string;
};

function startControllerProcess(params: {
  configPath: string;
  stateDir: string;
  gatewayPort: number;
  token: string;
  model: string;
  operationKey: string;
  governed?: boolean;
}): LineProcess<ControllerResult> {
  const script = `
    import { createInterface } from "node:readline";
    import { spawnSubagentDirect } from "./src/agents/subagent-spawn.ts";
    const control = createInterface({ input: process.stdin });
    control.on("line", async (line) => {
      if (line !== "START") {
        return;
      }
      const result = await spawnSubagentDirect({
        task: "process-boundary child intent probe",
        model: process.env.CHILD_MODEL,
        mode: "run",
        subagentRole: "leaf",
        idempotencyKey: process.env.CHILD_OPERATION,
        expectsCompletionMessage: false,
        ...(process.env.CHILD_GOVERNED === "1" ? { childLifecycleMode: "governed" } : {}),
      }, { agentSessionKey: "agent:main:main" });
      process.stdout.write("RESULT " + JSON.stringify(result) + "\\n");
      control.close();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${params.gatewayPort}`,
      OPENCLAW_GATEWAY_TOKEN: params.token,
      CHILD_MODEL: params.model,
      CHILD_OPERATION: params.operationKey,
      CHILD_GOVERNED: params.governed ? "1" : "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const waitFor = (prefix: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        if (!line.startsWith(prefix)) {
          return;
        }
        cleanup();
        resolve(line);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`controller process exited ${String(code)}: ${stderr.join("")}`));
      };
      const cleanup = () => {
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      lines.on("line", onLine);
      child.once("exit", onExit);
    });
  const ready = waitFor("RESULT ").then(
    (line) => JSON.parse(line.slice("RESULT ".length)) as ControllerResult,
  );
  return {
    child,
    ready,
    waitFor,
    close: async () => {
      await ready;
      await once(child, "close");
      lines.close();
    },
  };
}

const processBoundary = process.platform === "win32" ? describe.skip : describe;

processBoundary("child intent production process boundary", () => {
  it("uses separate controllers, spawnSubagentDirect, Gateway RPC, and one physical child", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-boundary-"));
    const configPath = path.join(stateDir, "openclaw.json");
    const modelCounter = path.join(stateDir, "model-requests");
    const physicalCounter = path.join(stateDir, "physical-starts");
    const token = "process-boundary-token";
    const cliScript =
      "const fs=require('node:fs');fs.appendFileSync(process.env.PHYSICAL_COUNTER,'start\\n');process.stdout.write('CLI-PROBE\\n');";
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: { mode: "local", auth: { mode: "token", token } },
        models: {
          providers: {
            "loopback-embedded": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              apiKey: "process-boundary",
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
            workspace: stateDir,
            model: { primary: "loopback-embedded/fake-model" },
            models: {
              "loopback-embedded/fake-model": { agentRuntime: { id: "openclaw" } },
              "fake-cli/fake-model": { agentRuntime: { id: "claude-cli" } },
            },
            cliBackends: {
              "fake-cli": {
                command: process.execPath,
                args: ["-e", cliScript],
                output: "text",
                input: "stdin",
              },
            },
          },
          list: [{ id: "main", default: true }],
        },
      }) + "\n",
      "utf8",
    );
    const model = startModelProcess({ counterPath: modelCounter });
    const modelReady = await model.ready;
    const configured = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      models: { providers: { "loopback-embedded": { baseUrl: string } } };
    };
    configured.models.providers["loopback-embedded"].baseUrl =
      `http://127.0.0.1:${modelReady.modelPort}/v1`;
    await fs.writeFile(configPath, JSON.stringify(configured) + "\n", "utf8");
    const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
    const previousState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const gateway = startGatewayProcess({
      configPath,
      stateDir,
      token,
      physicalCounter,
    });
    try {
      const ready = await gateway.ready;
      const embedded = startControllerProcess({
        configPath,
        stateDir,
        gatewayPort: ready.gatewayPort,
        token,
        model: "loopback-embedded/fake-model",
        operationKey: "embedded-boundary",
      });
      embedded.child.stdin?.write("START\\n");
      expect((await embedded.ready).status).toBe("accepted");
      await embedded.close();
      const cliControllers = [0, 1].map(() =>
        startControllerProcess({
          configPath,
          stateDir,
          gatewayPort: ready.gatewayPort,
          token,
          model: "fake-cli/fake-model",
          operationKey: "cli-boundary-same-operation",
        }),
      );
      for (const controller of cliControllers) {
        controller.child.stdin?.write("START\\n");
      }
      const cliResults = await Promise.all(cliControllers.map((controller) => controller.ready));
      expect(cliResults.every((result) => result.status === "accepted")).toBe(true);
      for (const controller of cliControllers) {
        await controller.close();
      }
      expect(
        (await fs.readFile(modelCounter, "utf8")).trim().split("\n").length,
      ).toBeGreaterThanOrEqual(1);
      expect((await fs.readFile(physicalCounter, "utf8")).trim().split("\n")).toHaveLength(1);
      const missingSigner = startControllerProcess({
        configPath,
        stateDir,
        gatewayPort: ready.gatewayPort,
        token,
        model: "loopback-embedded/fake-model",
        operationKey: "governed-without-signer",
        governed: true,
      });
      missingSigner.child.stdin?.write("START\n");
      expect((await missingSigner.ready).status).toBe("error");
      await missingSigner.close();
      expect((await fs.readFile(physicalCounter, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      try {
        await gateway.close();
      } finally {
        await model.close();
      }
      if (previousConfig === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfig;
      }
      if (previousState === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousState;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }, 180_000);
});
