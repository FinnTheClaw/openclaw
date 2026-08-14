import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

type GatewayReady = { gatewayPort: number; modelPort: number };

type GatewayProcess = {
  child: ChildProcess;
  ready: Promise<GatewayReady>;
  waitFor: (prefix: string) => Promise<string>;
  close: () => Promise<void>;
};

async function getFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("free-port probe did not return an address");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return port;
}

function startGatewayProcess(params: {
  configPath: string;
  stateDir: string;
  token: string;
  gatewayPort: number;
  embeddedCounter: string;
  physicalCounter: string;
}): GatewayProcess {
  const script = `
    import fs from "node:fs";
    import http from "node:http";
    import { createInterface } from "node:readline";
    import { startGatewayServer } from "./src/gateway/server.ts";

    const modelServer = http.createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }] }));
        return;
      }
      request.resume();
      request.once("end", () => {
        fs.appendFileSync(process.env.EMBEDDED_COUNTER, "request\\n");
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
    const modelAddress = modelServer.address();
    if (!modelAddress || typeof modelAddress === "string") throw new Error("model server address missing");
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    config.models.providers["loopback-embedded"].baseUrl = "http://127.0.0.1:" + modelAddress.port + "/v1";
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config) + "\\n");
    const gateway = await startGatewayServer(Number(process.env.GATEWAY_PORT), {
      bind: "loopback",
      host: "127.0.0.1",
      auth: { mode: "token", token: process.env.GATEWAY_TOKEN },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      sidecarStartup: "defer",
    });
    process.stdout.write("READY " + JSON.stringify({ gatewayPort: Number(process.env.GATEWAY_PORT), modelPort: modelAddress.port }) + "\\n");
    const control = createInterface({ input: process.stdin });
    control.on("line", async (line) => {
      if (line !== "CLOSE") {
        return;
      }
      await gateway.close({ reason: "process-boundary-test" });
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
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_GATEWAY_TOKEN: params.token,
      GATEWAY_PORT: String(params.gatewayPort),
      GATEWAY_TOKEN: params.token,
      EMBEDDED_COUNTER: params.embeddedCounter,
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

const processBoundary = process.platform === "win32" ? describe.skip : describe;

processBoundary("child intent production process boundary", () => {
  it("uses controller RPC, production Gateway bootstrap, agentCommand, embedded model, and CLI child probe", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-child-boundary-"));
    const configPath = path.join(stateDir, "openclaw.json");
    const embeddedCounter = path.join(stateDir, "embedded-requests");
    const physicalCounter = path.join(stateDir, "physical-starts");
    const token = "process-boundary-token";
    const gatewayPort = await getFreePort();
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
    const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
    const previousState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const gateway = startGatewayProcess({
      configPath,
      stateDir,
      token,
      gatewayPort,
      embeddedCounter,
      physicalCounter,
    });
    try {
      const ready = await gateway.ready;
      const { callGateway } = await import("../gateway/call.js");
      const call = (model: string, key: string) =>
        callGateway<{ status?: string }>({
          url: `ws://127.0.0.1:${ready.gatewayPort}`,
          token,
          method: "agent",
          mode: "backend",
          scopes: ["operator.admin"],
          expectFinal: true,
          timeoutMs: 120_000,
          params: {
            message: "Reply with the fixed probe token.",
            model,
            sessionKey: `agent:main:${key}`,
            idempotencyKey: key,
            deliver: false,
          },
        });
      expect((await call("loopback-embedded/fake-model", "embedded-boundary")).status).toBe("ok");
      expect((await call("fake-cli/fake-model", "cli-boundary")).status).toBe("ok");
      expect(
        (await fs.readFile(embeddedCounter, "utf8")).trim().split("\n").length,
      ).toBeGreaterThanOrEqual(1);
      expect((await fs.readFile(physicalCounter, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await gateway.close();
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
