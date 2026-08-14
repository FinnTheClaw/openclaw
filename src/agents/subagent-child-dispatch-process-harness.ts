import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  CHILD_DISPATCH_PROTOCOL_TIMEOUT_MS,
  emitChildDispatchProtocolEvent,
  releaseChildDispatchProtocolBarrier,
  waitForChildDispatchProtocolEvent,
} from "./subagent-child-dispatch-process-protocol.js";

export type ChildDispatchProcessHandle = {
  child: ChildProcess;
  ready: Promise<Record<string, unknown>>;
  stderrText: () => string;
  send: (value: Record<string, unknown>) => void;
  waitFor: (prefix: string, timeoutMs?: number) => Promise<string>;
  waitForAny: (prefixes: readonly string[], timeoutMs?: number) => Promise<string>;
  terminate: () => Promise<void>;
  close: () => Promise<void>;
};

const workerPath = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

function startWorker(params: {
  worker: string;
  env: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  stderrPath?: string;
}): ChildDispatchProcessHandle {
  const child = spawn(process.execPath, ["--import", "tsx", workerPath(params.worker)], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", ...params.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout! });
  const stdout: string[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  const stderr: string[] = [];
  const stderrFile = params.stderrPath
    ? createWriteStream(params.stderrPath, { flags: "a", encoding: "utf8" })
    : undefined;
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderr.push(text);
    stderrFile?.write(text);
  });
  const closeStderr = () => {
    stderrFile?.end();
  };
  child.once("close", closeStderr);
  const waitFor = (prefix: string, timeoutMs = CHILD_DISPATCH_PROTOCOL_TIMEOUT_MS) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `${params.worker} did not emit ${prefix}: stdout=${stdout.join("")} stderr=${stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      const onLine = (line: string) => {
        if (!line.startsWith(prefix)) {
          return;
        }
        cleanup();
        resolve(line);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(
          new Error(
            `${params.worker} exited ${String(code)}: stdout=${stdout.join("")} stderr=${stderr.join("")}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      lines.on("line", onLine);
      child.once("exit", onExit);
    });
  const waitForAny = (
    prefixes: readonly string[],
    timeoutMs = CHILD_DISPATCH_PROTOCOL_TIMEOUT_MS,
  ) =>
    new Promise<string>((resolve, reject) => {
      const matches = () =>
        stdout
          .join("")
          .split(/\r?\n/)
          .find((line) => prefixes.some((prefix) => line.startsWith(prefix)));
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `${params.worker} did not emit any of ${prefixes.join(", ")}: stdout=${stdout.join("")} stderr=${stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      const onLine = (line: string) => {
        if (!prefixes.some((prefix) => line.startsWith(prefix))) {
          return;
        }
        cleanup();
        resolve(line);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(
          new Error(
            `${params.worker} exited ${String(code)}: stdout=${stdout.join("")} stderr=${stderr.join("")}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        lines.off("line", onLine);
        child.off("exit", onExit);
      };
      const buffered = matches();
      if (buffered !== undefined) {
        cleanup();
        resolve(buffered);
        return;
      }
      lines.on("line", onLine);
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitedLine = matches();
        cleanup();
        if (exitedLine !== undefined) {
          resolve(exitedLine);
        } else {
          reject(
            new Error(
              `${params.worker} exited ${String(child.exitCode)}: stdout=${stdout.join("")} stderr=${stderr.join("")}`,
            ),
          );
        }
      }
    });
  const send = (value: Record<string, unknown>) => {
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error(`${params.worker} stdin closed`);
    }
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  return {
    child,
    ready: waitFor("READY ", params.readyTimeoutMs ?? 30_000).then(
      (line) => JSON.parse(line.slice(6)) as Record<string, unknown>,
    ),
    stderrText: () => stderr.join(""),
    send,
    waitFor,
    waitForAny,
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGKILL");
      await once(child, "close").catch(() => undefined);
      lines.close();
      closeStderr();
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      send({ op: "close" });
      try {
        await waitFor("CLOSED", 2_000);
      } catch {
        child.kill("SIGTERM");
        await Promise.race([
          once(child, "close"),
          new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 2_000);
          }),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, "close").catch(() => undefined);
      }
      lines.close();
      closeStderr();
    },
  };
}

export async function createChildDispatchHarness(params: { configPath: string }): Promise<{
  root: string;
  protocolPath: string;
  modelCounter: string;
  physicalCounter: string;
  stderrPaths: Readonly<{ gateway: string; controller: string; model: string }>;
  startModel: () => ChildDispatchProcessHandle;
  startGateway: (params?: {
    signer?: boolean;
    providerFailure?: "after-start";
  }) => ChildDispatchProcessHandle;
  startController: (params: { gatewayPort: number }) => ChildDispatchProcessHandle;
  allow: (eventId: string) => Promise<void>;
  deny: (eventId: string) => Promise<void>;
  next: (point: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  nextAny: (points: readonly string[], timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-child-dispatch-process-"));
  const bundledPluginsParent = path.join(process.cwd(), "dist", "extensions");
  await mkdir(bundledPluginsParent, { recursive: true });
  const bundledPluginsDir = await mkdtemp(
    path.join(bundledPluginsParent, `child-dispatch-process-${randomUUID()}-`),
  );
  await mkdir(path.join(bundledPluginsDir, "anthropic"), { recursive: true });
  await writeFile(
    path.join(bundledPluginsDir, "anthropic", "api.js"),
    'export const CLAUDE_CLI_BACKEND_ID = "claude-cli";\nexport const isClaudeCliProvider = (providerId) => providerId.trim().toLowerCase() === "claude-cli";\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(bundledPluginsDir, "anthropic", "openclaw.plugin.json"),
    '{"id":"anthropic","activation":{"onStartup":false},"enabledByDefault":false}\n',
    { mode: 0o600 },
  );
  const protocolPath = path.join(root, "protocol.jsonl");
  const modelCounter = path.join(root, "model-requests.jsonl");
  const physicalCounter = path.join(root, "physical-starts.jsonl");
  const stderrPaths = {
    gateway: path.join(root, "gateway.stderr.log"),
    controller: path.join(root, "controller.stderr.log"),
    model: path.join(root, "model.stderr.log"),
  } as const;
  const gateways: ChildDispatchProcessHandle[] = [];
  const controllers: ChildDispatchProcessHandle[] = [];
  const models: ChildDispatchProcessHandle[] = [];
  const seenBarrierIds = new Set<string>();
  const env = {
    CHILD_DISPATCH_PROTOCOL: protocolPath,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_GATEWAY_TOKEN: "child-dispatch-process-token",
    GATEWAY_TOKEN: "child-dispatch-process-token",
    PHYSICAL_COUNTER: physicalCounter,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
  };
  return {
    root,
    protocolPath,
    modelCounter,
    physicalCounter,
    stderrPaths,
    startModel: () => {
      const model = startWorker({
        worker: "subagent-child-dispatch-process-model-worker.ts",
        env: { MODEL_COUNTER: modelCounter },
        stderrPath: stderrPaths.model,
      });
      models.push(model);
      return model;
    },
    startGateway: (gatewayOptions) => {
      const gateway = startWorker({
        worker: "subagent-child-dispatch-process-worker.ts",
        readyTimeoutMs: 45_000,
        env: {
          ...env,
          ...(gatewayOptions?.signer === false
            ? { INSTALL_RECEIPT_SIGNER: "0" }
            : { INSTALL_RECEIPT_SIGNER: "1" }),
          ...(gatewayOptions?.providerFailure
            ? { CHILD_DISPATCH_PROVIDER_FAILURE: gatewayOptions.providerFailure }
            : {}),
        },
        stderrPath: stderrPaths.gateway,
      });
      gateways.push(gateway);
      return gateway;
    },
    startController: (controllerParams) => {
      const controller = startWorker({
        worker: "subagent-child-dispatch-controller-worker.ts",
        env: {
          ...env,
          CHILD_DISPATCH_GATEWAY_PORT: String(controllerParams.gatewayPort),
          INSTALL_RECEIPT_SIGNER: "1",
        },
        stderrPath: stderrPaths.controller,
      });
      controllers.push(controller);
      return controller;
    },
    allow: (eventId) => releaseChildDispatchProtocolBarrier({ path: protocolPath, id: eventId }),
    deny: (eventId) =>
      releaseChildDispatchProtocolBarrier({ path: protocolPath, id: eventId, action: "deny" }),
    next: async (point, timeoutMs) => {
      return await nextMatching((record) => record.point === point, timeoutMs);
    },
    nextAny: async (points, timeoutMs) => {
      const accepted = new Set(points);
      return await nextMatching((record) => accepted.has(record.point), timeoutMs);
    },
    close: async () => {
      for (const controller of controllers.toReversed()) {
        await controller.close().catch(() => undefined);
      }
      for (const gateway of gateways.toReversed()) {
        await gateway.close().catch(() => undefined);
      }
      for (const model of models.toReversed()) {
        await model.close().catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
      await rm(bundledPluginsDir, { recursive: true, force: true });
    },
  };

  async function nextMatching(
    predicate: (record: { point: string; id: string }) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    let event: Awaited<ReturnType<typeof waitForChildDispatchProtocolEvent>>;
    try {
      event = await waitForChildDispatchProtocolEvent({
        path: protocolPath,
        timeoutMs,
        predicate: (record) => predicate(record) && !seenBarrierIds.has(record.id),
      });
    } catch (error) {
      const protocol = await readFile(protocolPath, "utf8").catch(() => "");
      throw new Error(`${String(error)}; protocol=${protocol}`, { cause: error });
    }
    seenBarrierIds.add(event.id);
    await emitChildDispatchProtocolEvent({
      path: protocolPath,
      id: `observed:${event.id}`,
      point: "harness.observed",
      payload: { sourceId: event.id, sourcePoint: event.point },
    });
    return { id: event.id, point: event.point, ...event.payload };
  }
}

export async function readPhysicalStarts(
  pathname: string,
): Promise<readonly Record<string, unknown>[]> {
  try {
    const text = await readFile(pathname, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}
