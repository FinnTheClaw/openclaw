// Signal durable ingress tests cover queueing, claims, crash recovery, and poison events.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChannelIngressQueueForTests as createChannelIngressQueue } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSignalIngressEventId,
  createSignalIngressWorker,
  type SignalIngressPayload,
} from "./signal-ingress-queue.js";

const tempDirs: string[] = [];

async function makeQueue() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-ingress-"));
  tempDirs.push(stateDir);
  return createChannelIngressQueue<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir,
  });
}

function runtime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for Signal ingress test condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Signal durable ingress worker", () => {
  it("uses stable transport-byte ids without conflating different messages", () => {
    expect(createSignalIngressEventId({ event: "message", data: "one" })).toBe(
      createSignalIngressEventId({ event: "message", data: "one" }),
    );
    expect(createSignalIngressEventId({ event: "message", data: "one" })).not.toBe(
      createSignalIngressEventId({ event: "message", data: "two" }),
    );
  });

  it("persists a 100-message burst, exposes one working claim, and drains FIFO", async () => {
    const queue = await makeQueue();
    const handled: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      ownerId: "signal-ingress:999999:test",
      handleEvent: async (event) => {
        handled.push(event.data ?? "");
        if (event.data === "message-000") {
          await firstBlocked;
        }
      },
    });
    await worker.start();
    const messages = Array.from(
      { length: 100 },
      (_, index) => `message-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(
      messages.map((message, index) => worker.enqueue({ data: message }, index + 1)),
    );

    try {
      await waitUntil(async () => (await queue.listClaims()).length === 1);
    } catch (err) {
      throw new Error(
        `${String(err)}; pending=${(await queue.listPending({ limit: "all" })).length} claims=${(await queue.listClaims()).length}`,
        { cause: err },
      );
    }
    expect((await queue.listClaims()).map((claim) => claim.payload.event.data)).toEqual([
      "message-000",
    ]);
    expect(
      (await queue.listPending({ limit: "all" })).map((row) => row.payload.event.data),
    ).toEqual(messages.slice(1));

    releaseFirst();
    await waitUntil(async () => (await queue.listPending({ limit: "all" })).length === 0);
    await worker.waitForIdle();
    expect(handled).toEqual(messages);
    expect(await queue.listClaims()).toEqual([]);
  });

  it("deduplicates redelivery while pending and after completion", async () => {
    const queue = await makeQueue();
    const handleEvent = vi.fn(async () => undefined);
    const worker = createSignalIngressWorker({ queue, runtime: runtime(), handleEvent });
    await worker.start();
    const event = { event: "message", data: "same-envelope" };
    await worker.enqueue(event, 1);
    await worker.enqueue(event, 2);
    await worker.waitForIdle();
    await worker.enqueue(event, 3);
    await worker.waitForIdle();
    expect(handleEvent).toHaveBeenCalledTimes(1);
  });

  it("recovers a dead-owner claim at startup", async () => {
    const queue = await makeQueue();
    const deadEvent = { data: "dead" };
    await queue.enqueue(createSignalIngressEventId(deadEvent), {
      version: 1,
      event: deadEvent,
      receivedAt: 1,
    });
    const deadClaim = await queue.claim(createSignalIngressEventId(deadEvent), {
      ownerId: "signal-ingress:999999:dead",
    });
    expect(deadClaim).not.toBeNull();

    const handled: string[] = [];
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      handleEvent: async (event) => {
        handled.push(event.data ?? "");
      },
    });
    await worker.start();
    await worker.waitForIdle();
    expect(handled).toEqual(["dead"]);
    expect(await queue.listClaims()).toEqual([]);
    await worker.stop();
  });

  it("recovers an inactive same-process owner on reconnect", async () => {
    const queue = await makeQueue();
    const first = { data: "first" };
    await queue.enqueue(
      createSignalIngressEventId(first),
      {
        version: 1,
        event: first,
        receivedAt: 1,
      },
      { receivedAt: 1 },
    );
    await queue.claim(createSignalIngressEventId(first), {
      ownerId: `signal-ingress:${process.pid}:orphaned-live-pid`,
    });
    const handled: string[] = [];
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      handleEvent: async (event) => {
        handled.push(event.data ?? "");
      },
    });

    await worker.start();
    await worker.waitForIdle();
    expect(handled).toEqual(["first"]);
    expect(await queue.listClaims()).toEqual([]);
    await worker.stop();
  });

  it("never steals an active live owner's claim after heartbeat expiry", async () => {
    const queue = await makeQueue();
    const handled: string[] = [];
    const firstOwnerId = `signal-ingress:${process.pid}:active-first`;
    const firstWorker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      ownerId: firstOwnerId,
      claimRefreshMs: 10,
      handleEvent: async () => undefined,
    });
    const secondWorker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      ownerId: `signal-ingress:${process.pid}:active-second`,
      claimRefreshMs: 10,
      handleEvent: async (event) => {
        handled.push(`second:${event.data ?? ""}`);
      },
    });
    await firstWorker.start();
    const first = { data: "one" };
    await queue.enqueue(
      createSignalIngressEventId(first),
      {
        version: 1,
        event: first,
        receivedAt: 1,
      },
      { receivedAt: 1 },
    );
    const liveClaim = await queue.claim(createSignalIngressEventId(first), {
      ownerId: firstOwnerId,
    });
    expect(liveClaim).not.toBeNull();
    await secondWorker.start();
    await secondWorker.enqueue({ data: "two" }, 2);

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(handled).toEqual([]);
    expect(await queue.listClaims()).toHaveLength(1);
    expect(
      (await queue.listPending({ limit: "all" })).map((row) => row.payload.event.data),
    ).toEqual(["two"]);

    if (!liveClaim) {
      throw new Error("expected active-owner test claim");
    }
    expect(await queue.release(liveClaim, { recordAttempt: false })).toBe(true);
    await waitUntil(async () => (await queue.listPending({ limit: "all" })).length === 0);
    await Promise.all([firstWorker.waitForIdle(), secondWorker.waitForIdle()]);
    expect(handled).toEqual(["second:one", "second:two"]);
    expect(await queue.listClaims()).toEqual([]);
    await Promise.all([firstWorker.stop(), secondWorker.stop()]);
  });

  it("retries transient failures and dead-letters poison events without looping", async () => {
    const queue = await makeQueue();
    const attempts = new Map<string, number>();
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      maxAttempts: 3,
      retryDelaysMs: [0],
      handleEvent: async (event) => {
        const key = event.data ?? "";
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        if (key === "transient" && attempt < 2) {
          throw new Error("temporary");
        }
        if (key === "poison") {
          throw new Error("permanent");
        }
      },
    });
    await worker.start();
    await worker.enqueue({ data: "transient" }, 1);
    await worker.enqueue({ data: "poison" }, 2);
    await worker.enqueue({ data: "after" }, 3);
    await worker.waitForIdle();
    expect(attempts.get("transient")).toBe(2);
    expect(attempts.get("poison")).toBe(3);
    expect(attempts.get("after")).toBe(1);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);
  });

  it("returns an interrupted working item to queued without consuming retry budget", async () => {
    const queue = await makeQueue();
    const abortController = new AbortController();
    const firstWorker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      abortSignal: abortController.signal,
      handleEvent: async () => {
        await new Promise<void>((_resolve, reject) => {
          abortController.signal.addEventListener(
            "abort",
            () => reject(new Error("dispatch canceled by gateway shutdown")),
            { once: true },
          );
        });
      },
    });
    await firstWorker.start();
    await firstWorker.enqueue({ data: "survive-shutdown" }, 1);
    await waitUntil(async () => (await queue.listClaims()).length === 1);

    abortController.abort(new Error("simulated gateway shutdown"));
    await firstWorker.stop();
    expect(await queue.listClaims()).toEqual([]);
    const pending = await queue.listPending({ limit: "all" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.event.data).toBe("survive-shutdown");
    expect(pending[0]?.attempts).toBe(0);

    const handled = vi.fn(async () => undefined);
    const replacement = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      handleEvent: handled,
    });
    await replacement.start();
    await replacement.waitForIdle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);
    await replacement.stop();
  });

  it("dead-letters a repeatedly abandoned event before it can loop forever", async () => {
    const queue = await makeQueue();
    const event = { data: "crash-loop" };
    const id = createSignalIngressEventId(event);
    await queue.enqueue(id, { version: 1, event, receivedAt: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = await queue.claim(id, { ownerId: `signal-ingress:999999:dead-${attempt}` });
      expect(claim).not.toBeNull();
      if (!claim) {
        throw new Error("expected crash-loop test claim");
      }
      expect(await queue.release(claim, { lastError: "simulated crash" })).toBe(true);
    }
    const handleEvent = vi.fn(async () => undefined);
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      maxAttempts: 3,
      handleEvent,
    });
    await worker.start();
    await worker.waitForIdle();
    expect(handleEvent).not.toHaveBeenCalled();
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(await queue.listClaims()).toEqual([]);
    expect((await queue.enqueue(id, { version: 1, event, receivedAt: 2 })).kind).toBe("failed");
    await worker.stop();
  });

  it("refreshes the working claim during long processing", async () => {
    const queue = await makeQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createSignalIngressWorker({
      queue,
      runtime: runtime(),
      claimRefreshMs: 10,
      handleEvent: async () => blocked,
    });
    await worker.start();
    await worker.enqueue({ data: "slow" }, 1);
    await waitUntil(async () => ((await queue.listClaims())[0]?.claim.claimedAt ?? 0) > 1);
    const firstClaimedAt = (await queue.listClaims())[0]?.claim.claimedAt ?? 0;
    await waitUntil(
      async () => ((await queue.listClaims())[0]?.claim.claimedAt ?? 0) > firstClaimedAt,
    );
    release();
    await worker.waitForIdle();
  });
});
