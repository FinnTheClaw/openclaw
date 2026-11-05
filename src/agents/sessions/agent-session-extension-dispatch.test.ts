import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "./extensions/types.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.cleanup());

function streamAnswer(model: Model, consumed: readonly Promise<void>[] = []) {
  const stream = createAssistantMessageEventStream();
  const message = createAssistant(model, [{ type: "text", text: "abc" }]);
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: { ...message, content: [{ type: "text", text: "" }] },
  });
  void (async () => {
    for (const [index, delta] of ["a", "b", "c"].entries()) {
      stream.push({ type: "text_delta", contentIndex: 0, delta });
      await consumed[index];
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  })();
  return stream;
}

describe("AgentSession text extension dispatch", () => {
  it.each(["setSessionName", "appendEntry", "setActiveTools", "shutdownContext"] as const)(
    "L13-F001 retires retained extension handles after SDK reload: %s",
    async (operation) => {
      const root = tempDirs.make("openclaw-session-extension-reload-");
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const apis: ExtensionAPI[] = [];
      const shutdownContexts: ExtensionContext[] = [];
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (api) => {
            apis.push(api);
            api.on("session_shutdown", (event, context) => {
              shutdownContexts.push(context);
              api.appendEntry("shutdown-allowed", { reason: event.reason });
            });
          },
        ],
      });
      await loader.reload();
      const initialRuntime = loader.getExtensions().runtime;
      const executeTool = vi.fn(async () => ({ content: [], details: undefined }));
      const tools: ToolDefinition[] = ["fixture-a", "fixture-b"].map((name) => ({
        name,
        label: name,
        description: "Synthetic reload identity fixture; never executed",
        parameters: Type.Object({}),
        execute: executeTool,
      }));
      const { session, sessionManager } = await createTestSession({
        settingsManager,
        resourceLoader: loader,
        customTools: tools,
      });
      try {
        expect(apis).toHaveLength(1);
        const initial = apis[0]!;
        initial.setSessionName("initial-name");
        initial.appendEntry("initial-entry", { generation: 1 });
        initial.setActiveTools(["fixture-a"]);
        expect(initial.getSessionName()).toBe("initial-name");
        expect(initial.getActiveTools()).toEqual(["fixture-a"]);

        await session.reload();

        expect(apis).toHaveLength(2);
        expect(loader.getExtensions().errors).toEqual([]);
        expect(loader.getExtensions().runtime).not.toBe(initialRuntime);
        expect(shutdownContexts).toHaveLength(1);
        expect(sessionManager.getEntries()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "custom",
              customType: "shutdown-allowed",
              data: { reason: "reload" },
            }),
          ]),
        );
        const current = apis[1]!;
        expect(current).not.toBe(initial);
        current.setSessionName("current-name");
        current.appendEntry("current-entry", { generation: 2 });
        current.setActiveTools(["fixture-b"]);
        expect(current.getSessionName()).toBe("current-name");
        expect(current.getActiveTools()).toEqual(["fixture-b"]);
        const entries = structuredClone(sessionManager.getEntries());
        let retiredError: unknown;
        try {
          if (operation === "setSessionName") initial.setSessionName("stale-name");
          else if (operation === "appendEntry")
            initial.appendEntry("stale-entry", { retired: true });
          else if (operation === "setActiveTools") initial.setActiveTools(["fixture-a"]);
          else shutdownContexts[0]!.isIdle();
        } catch (error) {
          retiredError = error;
        }
        const observed = {
          retiredRejected: retiredError instanceof Error && /stale/.test(retiredError.message),
          name: current.getSessionName(),
          tools: current.getActiveTools(),
          entries: sessionManager.getEntries(),
        };
        expect(executeTool).not.toHaveBeenCalled();
        expect(streamMocks.streamSimple).not.toHaveBeenCalled();
        session.dispose();
        expect(() => current.getSessionName()).toThrow(/stale/);
        expect(observed).toEqual({
          retiredRejected: true,
          name: "current-name",
          tools: ["fixture-b"],
          entries,
        });
      } finally {
        session.dispose();
      }
    },
  );

  it("L13-F001 preserves an intentionally reused extension runtime", async () => {
    const root = tempDirs.make("openclaw-session-extension-shared-runtime-");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const apis: ExtensionAPI[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (api) => {
          apis.push(api);
        },
      ],
    });
    await loader.reload();
    const runtime = loader.getExtensions().runtime;
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: loader,
    });
    try {
      expect(apis).toHaveLength(1);
      const api = apis[0]!;
      api.setSessionName("before-shared-reload");
      expect(api.getSessionName()).toBe("before-shared-reload");
      // Custom loaders may intentionally keep their extension instances/runtime.
      loader.reload = async () => {};

      await session.reload();

      expect(loader.getExtensions().runtime).toBe(runtime);
      expect(apis).toHaveLength(1);
      api.setSessionName("after-shared-reload");
      api.appendEntry("shared-runtime-active", { retained: true });
      expect(sessionManager.getSessionName()).toBe("after-shared-reload");
      expect(sessionManager.getEntries()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "custom",
            customType: "shared-runtime-active",
            data: { retained: true },
          }),
        ]),
      );
      expect(session.extensionRunner.createContext().isIdle()).toBe(true);
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
      session.dispose();
      expect(() => api.getSessionName()).toThrow(/stale/);
    } finally {
      session.dispose();
    }
  });

  it.each(["none", "unrelated"])(
    "delivers updates without extension dispatch when handlers are %s",
    async (mode) => {
      const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
      if (mode === "unrelated") {
        handlers.set("turn_start", [async () => undefined]);
      }
      streamMocks.streamSimple.mockImplementation((model) => streamAnswer(model));
      const { session } = await createTestSession({
        resourceLoader: createResourceLoader(handlers),
      });
      const dispatch = vi.spyOn(session.extensionRunner, "emit");
      const deltas: string[] = [];
      session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas.push(event.assistantMessageEvent.delta);
        }
      });

      await session.prompt("answer");

      expect(deltas.join("")).toBe("abc");
      expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "abc" }] });
      expect(dispatch.mock.calls.filter(([event]) => event.type === "message_update")).toEqual([]);
    },
  );

  it("observes live handler registration and awaits handlers inside write settlement", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["message_update", []],
    ]);
    let settling = false;
    const observed: string[] = [];
    const consumed = [createDeferred(), createDeferred(), createDeferred()];
    streamMocks.streamSimple.mockImplementation((model) =>
      streamAnswer(
        model,
        consumed.map(({ promise }) => promise),
      ),
    );
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      withSessionWriteSettlement: async (run) => {
        settling = true;
        try {
          return await run();
        } finally {
          settling = false;
        }
      },
    });
    session.subscribe((event) => {
      if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") {
        return;
      }
      const delta = event.assistantMessageEvent.delta;
      observed.push(`listener:${delta}:${settling}`);
      if (delta === "a") {
        handlers.set("message_update", [
          async () => {
            await Promise.resolve();
            observed.push(`handler:${settling}`);
            handlers.delete("message_update");
          },
        ]);
      }
      consumed.shift()?.resolve();
    });

    await session.prompt("answer");

    expect(observed).toEqual([
      "listener:a:false",
      "handler:true",
      "listener:b:true",
      "listener:c:false",
    ]);
  });
});
