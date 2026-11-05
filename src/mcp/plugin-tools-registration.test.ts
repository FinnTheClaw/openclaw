import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as schedulerModule from "../infra/gateway-scheduler.js";
import {
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../plugin-sdk/logging-core.js";
import { resolvePluginProviders } from "../plugin-sdk/provider-catalog-runtime.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { acquireStandalonePluginToolRegistry } from "../plugins/tools.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createCodexSupervisionToolsMcpServer } from "./codex-supervision-tools-serve.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";
import { acquirePluginToolsForMcp } from "./plugin-tools-serve.js";
import { createToolsMcpServer, serveRegisteredToolsMcpServer } from "./tools-stdio-server.js";

let sequence = 0;
function nativePlugin(
  options: { failDisposal?: boolean; abortSdk?: boolean; policyPair?: boolean } = {},
) {
  useNoBundledPlugins();
  const key = `__mcp_registration_native_${sequence++}`;
  const toolNames = options.policyPair ? ["read_tool", "write_tool"] : ["mcp_native_read"];
  const state: {
    database?: DatabaseSync;
    disposals: number;
    factories: number;
    returnedToolNames: string[];
    toolCalls: string[];
    workspaceDir?: string;
    aborted: Deferred;
    started: Deferred;
    finish: Deferred;
    abortReason?: unknown;
    abortFailure?: unknown;
    abortRead?: unknown;
    resolvePluginProviders: typeof resolvePluginProviders;
  } = {
    disposals: 0,
    factories: 0,
    returnedToolNames: [],
    toolCalls: [],
    aborted: createDeferredCore(),
    started: createDeferredCore(),
    finish: createDeferredCore(),
    // This scope fixture shares its host SDK; the stdio fixture covers native SDK imports.
    resolvePluginProviders,
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id: "mcp-native",
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: "mcp-native", register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const { resolvePluginProviders } = state;
  const db = state.database = new DatabaseSync(":memory:");
  api.lifecycle.registerRuntimeLifecycle({ id: "native", dispose() {
    state.disposals++;
    db.close();
    if (${options.failDisposal === true}) throw new Error("synthetic registration disposal failure");
  }});
  api.registerProvider({ id: "mcp-native", label: "Native", auth: [],
    isCacheTtlEligible() { state.abortRead = db.prepare("SELECT 42 AS n").get().n; return true; }
  });
  api.registerTool(() => {
    state.factories++;
    if (${options.policyPair === true}) {
      state.returnedToolNames = ${JSON.stringify(toolNames)};
      return state.returnedToolNames.map(name => ({
        name, label: name, description: name,
        parameters: { type: "object", properties: {} },
        async execute() {
          state.toolCalls.push(name);
          return { content: [{ type: "text", text: name + " inert result" }] };
        }
      }));
    }
    return { name: "mcp_native_read", label: "Native read", description: "Native read",
      parameters: { type: "object", properties: {} },
      async execute(_id, _params, signal) {
        if (${options.abortSdk === true}) {
          signal.addEventListener("abort", () => {
            state.abortReason = signal.reason;
            try {
              const provider = resolvePluginProviders({ config: api.config, env: process.env,
                workspaceDir: state.workspaceDir, onlyPluginIds: ["mcp-native"], registryScope: "loaded"
              }).find((entry) => entry.id === "mcp-native");
              if (!provider || provider.isCacheTtlEligible({ provider: "mcp-native", modelId: "abort" }) !== true) {
                throw new Error("Abort callback lost its admitted provider registry");
              }
            } catch (error) { state.abortFailure = error; }
            finally { state.aborted.resolve(); }
          }, { once: true });
          state.started.resolve();
          await state.finish.promise;
        }
        return { content: [{ type: "text", text: String(db.prepare("SELECT 42 AS n").get().n) }] }; }
    };
  }, { names: ${JSON.stringify(toolNames)} });
}};`,
  });
  state.workspaceDir = plugin.dir;
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      providers: [plugin.id],
      contracts: { tools: toolNames },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  const config: OpenClawConfig = {
    plugins: {
      allow: [plugin.id],
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
    },
  };
  return {
    state,
    config,
    acquire: () =>
      acquireStandalonePluginToolRegistry({
        context: { workspaceDir: plugin.dir, config },
      }),
    cleanup() {
      if (state.database?.isOpen) {
        state.database.close();
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function causes(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(causes);
  }
  return error instanceof Error && error.cause !== undefined ? causes(error.cause) : [error];
}

describe("MCP serving registration ownership", () => {
  it.each([
    {
      label: "global allowlist",
      toolPolicy: { allow: ["read_tool"] },
      expectedNames: ["read_tool"],
    },
    {
      label: "profile plus alsoAllow",
      toolPolicy: { profile: "minimal", alsoAllow: ["read_tool"] },
      expectedNames: ["read_tool"],
    },
    {
      label: "explicit pair allowlist",
      toolPolicy: { allow: ["read_tool", "write_tool"] },
      expectedNames: ["read_tool", "write_tool"],
    },
    {
      label: "unrestricted",
      toolPolicy: undefined,
      expectedNames: ["read_tool", "write_tool"],
    },
  ] satisfies Array<{
    label: string;
    toolPolicy: OpenClawConfig["tools"];
    expectedNames: string[];
  }>)("L07-F01 applies agentless final policy: $label", async ({ toolPolicy, expectedNames }) => {
    vi.stubEnv("OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", "");
    const fixture = nativePlugin({ policyPair: true });
    const config: OpenClawConfig = {
      ...fixture.config,
      ...(toolPolicy ? { tools: toolPolicy } : {}),
    };
    const originalConfig = structuredClone(config);
    const argumentsValue = { marker: "synthetic argument" };
    const originalArguments = structuredClone(argumentsValue);
    let acquisition: Awaited<ReturnType<typeof acquirePluginToolsForMcp>> | undefined;
    try {
      acquisition = await acquirePluginToolsForMcp({ config });
      const tools = acquisition.resolveTools();
      // Prove the real nonoptional factory returned both tools before grading final policy.
      expect(fixture.state.factories).toBe(1);
      expect(fixture.state.returnedToolNames).toEqual(["read_tool", "write_tool"]);
      expect(fixture.state.database?.isOpen).toBe(true);
      const handlers = createPluginToolsMcpHandlers(tools);
      const listed = await handlers.listTools();
      const readResult = await handlers.callTool({ name: "read_tool", arguments: argumentsValue });
      const writeResult = await handlers.callTool({
        name: "write_tool",
        arguments: argumentsValue,
      });
      const permitsWrite = expectedNames.includes("write_tool");
      // Capture every outcome, including inert execution, before the joint policy assertion.
      expect({
        resolvedNames: tools.map((tool) => tool.name),
        listedNames: listed.tools.map((tool) => tool.name),
        readResult,
        writeResult,
        calls: fixture.state.toolCalls,
        config,
        argumentsValue,
      }).toEqual({
        resolvedNames: expectedNames,
        listedNames: expectedNames,
        readResult: { content: [{ type: "text", text: "read_tool inert result" }] },
        writeResult: permitsWrite
          ? { content: [{ type: "text", text: "write_tool inert result" }] }
          : { isError: true, content: [{ type: "text", text: "Unknown tool: write_tool" }] },
        calls: permitsWrite ? ["read_tool", "write_tool"] : ["read_tool"],
        config: originalConfig,
        argumentsValue: originalArguments,
      });
    } finally {
      try {
        await acquisition?.release();
      } finally {
        fixture.cleanup();
      }
    }
    expect(fixture.state.disposals).toBe(1);
    expect(fixture.state.database?.isOpen).toBe(false);
  });

  it("keeps supplied tools usable across close/reconnect until their caller releases registration", async () => {
    const fixture = nativePlugin();
    const acquisition = await fixture.acquire();
    const server = createToolsMcpServer({
      name: "native-reconnect",
      tools: acquisition.resolveTools(),
    });
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const [outbound, inbound] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "native-client", version: "0.0.0" });
        try {
          await Promise.all([server.connect(inbound), client.connect(outbound)]);
          expect(await client.callTool({ name: "mcp_native_read" })).toMatchObject({
            content: [{ text: "42" }],
          });
        } finally {
          await server.close();
          await client.close();
        }
        expect(fixture.state.database?.isOpen).toBe(true);
        expect(fixture.state.disposals).toBe(0);
      }
      await acquisition.release();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      await server.close();
      await acquisition.release();
      fixture.cleanup();
    }
  });

  it.each(["standalone", "borrowed"] as const)(
    "releases registrations and only its owned scheduler after validation fails (%s)",
    async (ownership) => {
      const fixture = nativePlugin();
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const host = ownership === "borrowed" ? new LegacyPluginSdkResourceHost() : undefined;
      host?.bindScheduler(scheduler);
      const constructor = vi
        .spyOn(schedulerModule, "GatewayScheduler")
        .mockImplementation(function () {
          return scheduler;
        });
      const previouslyEnabled = areDiagnosticsEnabledForProcess();
      const heartbeats: string[] = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "diagnostic.heartbeat") {
          heartbeats.push(event.type);
        }
      });
      const serve = () =>
        serveRegisteredToolsMcpServer({
          acquireRegistry: async () => {
            startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
            logWebhookReceived({ channel: "test" });
            await clock.advanceBy(30_000);
            await waitForDiagnosticEventsDrained();
            expect(heartbeats).toHaveLength(1);
            return fixture.acquire();
          },
          createServer: (tools) => createCodexSupervisionToolsMcpServer({ tools }),
        });
      try {
        setDiagnosticsEnabledForProcess(true);
        await expect(host ? host.run(serve) : serve()).rejects.toThrow(
          "Install or update @openclaw/codex",
        );
        expect(fixture.state.factories).toBe(1);
        expect(fixture.state.database?.isOpen).toBe(false);
        expect(fixture.state.disposals).toBe(1);
        expect(scheduler.signal.aborted).toBe(ownership === "standalone");
        expect(scheduler.nextWakeAtMs).toBe(
          ownership === "standalone" ? null : clock.clock.now() + 30_000,
        );
      } finally {
        stopDiagnosticHeartbeat();
        unsubscribe();
        await host?.close();
        await scheduler.stop();
        constructor.mockRestore();
        setDiagnosticsEnabledForProcess(previouslyEnabled);
        fixture.cleanup();
      }
    },
  );

  it("does not revive an acquired view when the same registry objects are reactivated", async () => {
    const fixture = nativePlugin();
    const acquisition = await fixture.acquire();
    try {
      expect(acquisition.resolveTools()).toHaveLength(1);
      expect(fixture.state.factories).toBe(1);
      await acquisition.release();
      markPluginRegistryActive(acquisition.registry);
      expect(() => acquisition.resolveTools()).toThrow("Plugin tool registry has been released");
      expect(fixture.state.factories).toBe(1);
      expect(fixture.state.database?.isOpen).toBe(false);
    } finally {
      await acquisition.release();
      fixture.cleanup();
    }
  });

  it("keeps peer cancellation SDK borrows with the admitted host under a foreign ambient host", async () => {
    const fixture = nativePlugin({ abortSdk: true });
    const admittedHost = new LegacyPluginSdkResourceHost();
    const foreignHost = new LegacyPluginSdkResourceHost();
    const acquisition = await admittedHost.run(fixture.acquire);
    const server = withPluginRuntimeRegistryScope(acquisition.registry, () =>
      createToolsMcpServer({
        name: "native-peer-cancel",
        tools: admittedHost.run(acquisition.resolveTools),
        sdkResourceHost: admittedHost,
      }),
    );
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "native-peer", version: "0.0.0" });
    let call: Promise<unknown> | undefined;
    try {
      await Promise.all([server.connect(inbound), client.connect(outbound)]);
      const controller = new AbortController();
      call = client
        .callTool({ name: "mcp_native_read" }, undefined, { signal: controller.signal })
        .catch((error: unknown) => error);
      await Promise.race([
        fixture.state.started.promise,
        call.then(() => {
          throw new Error("The tool completed before native work started");
        }),
      ]);
      // The peer shares the registry but owns a different SDK lifetime.
      foreignHost.run(() =>
        withPluginRuntimeRegistryScope(acquisition.registry, () =>
          controller.abort("peer cancellation reason"),
        ),
      );
      await fixture.state.aborted.promise;
      fixture.state.finish.resolve();
      await server.close();
      await call;
      expect(fixture.state.abortReason).toBe("peer cancellation reason");
      expect(fixture.state.abortFailure).toBeUndefined();
      expect(fixture.state.abortRead).toBe(42);
      await acquisition.release();
      await admittedHost.close();
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
    } finally {
      fixture.state.finish.resolve();
      await server.close();
      await client.close();
      await call;
      await acquisition.release();
      await admittedHost.close();
      await foreignHost.close();
      fixture.cleanup();
    }
  });

  it.each([false, true])(
    "joins owned stdio self-close without replacing the caller callback (throws: %s)",
    async (throws) => {
      const fixture = nativePlugin();
      const closeError = new Error("caller close callback failed");
      let callbacks = 0;
      const onclose = () => {
        callbacks++;
        if (throws) {
          throw closeError;
        }
      };
      let server: ReturnType<typeof createToolsMcpServer> | undefined;
      let selfClose: Promise<unknown> | undefined;
      try {
        const servingFailure = await serveRegisteredToolsMcpServer({
          acquireRegistry: fixture.acquire,
          createServer(tools, sdkResourceHost) {
            server = createToolsMcpServer({ name: "native-self-close", tools, sdkResourceHost });
            // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server exposes callback properties, not EventTarget.
            server.onclose = onclose;
            const created = server;
            queueMicrotask(() => {
              const transport = created.transport;
              if (!transport) {
                throw new Error("Expected the connected owned stdio transport");
              }
              selfClose = transport.close().then(
                () => undefined,
                (error: unknown) => error,
              );
            });
            return server;
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(await selfClose).toBe(throws ? closeError : undefined);
        expect(servingFailure).toBe(throws ? closeError : undefined);
        expect(callbacks).toBe(1);
        expect(server?.onclose).toBe(onclose);
        expect(fixture.state.database?.isOpen).toBe(false);
        expect(fixture.state.disposals).toBe(1);
      } finally {
        await selfClose;
        await server?.close();
        fixture.cleanup();
      }
    },
  );

  it("preserves real SDK connect and transport-close errors while joining a failed native disposer once", async () => {
    const fixture = nativePlugin({ failDisposal: true });
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const transportClose = inbound.close.bind(inbound);
    vi.spyOn(inbound, "close").mockImplementation(async () => {
      await transportClose();
      throw new Error("synthetic transport close failure");
    });
    const previousOnClose = vi.fn();
    let connection: Promise<void> | undefined;
    let server: ReturnType<typeof createToolsMcpServer> | undefined;
    try {
      const failure = await serveRegisteredToolsMcpServer({
        acquireRegistry: fixture.acquire,
        createServer(tools, sdkResourceHost) {
          server = createToolsMcpServer({ name: "failed-native", tools, sdkResourceHost });
          // The SDK rejects a second connection while this real transport is attached.
          // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server exposes a callback property, not EventTarget.
          server.onclose = previousOnClose;
          connection = server.connect(inbound);
          return server;
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await connection;
      const messages = causes(failure).map(String);
      expect(messages).toHaveLength(3);
      expect(messages.filter((message) => message.includes("Already connected"))).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("synthetic transport close failure")),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("synthetic registration disposal failure")),
      ).toHaveLength(1);
      expect(fixture.state.database?.isOpen).toBe(false);
      expect(fixture.state.disposals).toBe(1);
      expect(previousOnClose).toHaveBeenCalledOnce();
      expect(server?.onclose).toBe(previousOnClose);
    } finally {
      await outbound.close();
      fixture.cleanup();
    }
  });
});
