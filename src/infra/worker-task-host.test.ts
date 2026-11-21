import { once } from "node:events";
import { MessageChannel, MessagePort } from "node:worker_threads";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { expect, it, vi, type MockInstance } from "vitest";
import * as postgres from "./postgres-sync/pool.js";
import { encodeNativeWorkerFailure } from "./worker-native-error.js";
import { NativeWorker } from "./worker-native-handle.js";
import type { NativeWorkerRuntime } from "./worker-native-lifecycle.types.js";
import { createWorkerTaskHost } from "./worker-task-host.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

it.each(["warm", "admission", "postgres"] as const)(
  "delivers %s context ports in order without copying warm transfer lists",
  async (kind) => {
    const transport = new MessageChannel();
    const channels = Array.from(
      { length: kind === "warm" ? 0 : kind === "postgres" ? 5 : 1 },
      () => new MessageChannel(),
    );
    const context: WorkerTaskContext = {
      deletedAgentDatabaseFences: [],
      databaseAdmissionPort: channels[0]?.port1,
      postgresPool:
        kind === "postgres"
          ? {
              allocation: new SharedArrayBuffer(4),
              services: channels.slice(1).map(({ port1 }) => ({
                port: port1,
                signal: new SharedArrayBuffer(8),
              })),
            }
          : undefined,
    };
    const prepare = vi.spyOn(postgres, "postgresPoolTransferList");
    let received: WorkerTaskContext | undefined;
    try {
      const transfers = createWorkerTaskHost().taskContextTransferList!(context);
      if (kind === "warm") {
        expect(transfers === prepare.mock.results[0]?.value).toBe(true);
      }
      expect(transfers).toEqual(channels.map(({ port1 }) => port1));
      expect(context.postgresPool?.services.length ?? 0).toBe(kind === "postgres" ? 4 : 0);
      const delivery = once(transport.port2, "message");
      transport.port1.postMessage(context, [...transfers]);
      [received] = await delivery;
      const ports = [
        received?.databaseAdmissionPort,
        ...(received?.postgresPool?.services.map(({ port }) => port) ?? []),
      ].filter((port) => port !== undefined);
      await Promise.all(
        ports.map(async (port, index) => {
          const reply = once(channels[index]!.port2, "message");
          port.postMessage(index);
          expect(await reply).toEqual([index]);
        }),
      );
    } finally {
      prepare.mockRestore();
      received?.databaseAdmissionPort?.close();
      received?.postgresPool?.services.forEach(({ port }) => port.close());
      transport.port1.close();
      transport.port2.close();
      channels.forEach(({ port1, port2 }) => {
        port1.close();
        port2.close();
      });
    }
  },
);

it.each(["constructor refusal", "normal join"] as const)(
  "releases the task admission relay on %s without inventing an exit",
  async (outcome) => {
    const url = new URL("file:///synthetic-task.worker.mjs");
    const post = vi.fn<NativeWorkerRuntime["post"]>();
    const handles = new Map<number, NativeWorker>();
    const worker = new NativeWorker(
      {
        handles,
        post,
        service() {},
        refreshReference() {},
        resourceBroker() {
          throw new Error("This worker owns no broker resource");
        },
      },
      1,
      url,
      false,
      false,
    );
    handles.set(worker.id, worker);
    const exit = vi.fn();
    worker.on("exit", exit);
    const host = createWorkerTaskHost({ databaseAccess: "read-only" });
    let disposeFixtureRelay: (() => void) | undefined;
    const pool = new WorkerTaskPoolCore<string, string>(
      { workerUrl: url, maxWorkers: 1, idleTimeoutMs: 0 },
      {
        ...host,
        requiresReady: true,
        createWorker: () => ({ worker, native: worker }),
        captureTaskContext(handle) {
          const previous = worker.listeners("exit");
          const context = host.captureTaskContext(handle);
          // Tear down a leaked relay on a red baseline without emitting an exit.
          const added = worker.listeners("exit").find((listener) => !previous.includes(listener));
          disposeFixtureRelay = added && (() => added(undefined));
          return context;
        },
      },
    );
    let relayClose: MockInstance<MessagePort["close"]> | undefined;
    const result = pool.run("synthetic input", {});
    void result.catch(() => undefined);
    try {
      const admissionPort = post.mock.calls.find(([message]) => message.type === "post")?.[1]?.[0];
      if (!(admissionPort instanceof MessagePort)) {
        throw new Error("Expected the first task to carry an admission relay");
      }
      relayClose = vi.spyOn(admissionPort, "close");
      if (outcome === "constructor refusal") {
        worker.receive({
          type: "create-error",
          id: worker.id,
          error: encodeNativeWorkerFailure(new TypeError("synthetic constructor refusal")),
        });
        await expect(result).rejects.toMatchObject({
          code: "unavailable",
          cause: { message: "synthetic constructor refusal" },
        });
        await pool.close();
        expect(exit).not.toHaveBeenCalled();
      } else {
        worker.receive({ type: "created", id: worker.id, threadId: 42 });
        worker.receive({ type: "message", id: worker.id, value: { status: "ready" } });
        worker.receive({
          type: "message",
          id: worker.id,
          value: { status: "ok", taskId: 1, value: "synthetic result" },
        });
        await expect(result).resolves.toBe("synthetic result");
        expect(relayClose).not.toHaveBeenCalled();
        const closing = pool.close();
        worker.receive({ type: "stopped", id: worker.id, code: 0 });
        await closing;
        expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      }
      expect(relayClose).toHaveBeenCalledOnce();
    } finally {
      if (worker.threadId !== -1) {
        worker.receive({ type: "stopped", id: worker.id, code: 0 });
      }
      await pool.close();
      if (relayClose && relayClose.mock.calls.length === 0) {
        disposeFixtureRelay?.();
      }
      relayClose?.mockRestore();
    }
  },
);
