import type { AssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamWithIdleTimeout } from "./llm-idle-timeout.js";

function createNeverYieldingStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  };
}

describe("streamWithIdleTimeout caller cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preempts a provider iterator that ignores abort", async () => {
    vi.useFakeTimers();
    const callerAbortController = new AbortController();
    const callerReason = new Error("caller cancelled");
    const baseFn = vi.fn().mockReturnValue(createNeverYieldingStream());
    const onIdleTimeout = vi.fn();
    const iterator = (
      streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(
        {} as Parameters<typeof baseFn>[0],
        {} as Parameters<typeof baseFn>[1],
        { signal: callerAbortController.signal },
      ) as AsyncIterable<unknown>
    )[Symbol.asyncIterator]();
    const outcome = iterator.next().catch((error: unknown) => error);

    callerAbortController.abort(callerReason);

    await expect(outcome).resolves.toMatchObject({
      name: "AbortError",
      message: callerReason.message,
      cause: callerReason,
    });
    await vi.advanceTimersByTimeAsync(50);
    const providerSignal = (baseFn.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined)
      ?.signal;
    expect([providerSignal?.reason, onIdleTimeout.mock.calls.length]).toEqual([callerReason, 0]);
  });

  it("preempts provider stream creation", async () => {
    vi.useFakeTimers();
    const callerAbortController = new AbortController();
    const callerReason = new Error("caller cancelled");
    const baseFnMock = vi.fn(
      (_model: unknown, _context: unknown, _options?: { signal?: AbortSignal }) =>
        new Promise<AssistantMessageEventStream>(() => {}),
    );
    const baseFn = baseFnMock as unknown as Parameters<typeof streamWithIdleTimeout>[0];
    const onIdleTimeout = vi.fn();
    const pending = streamWithIdleTimeout(baseFn, 50, onIdleTimeout)(
      {} as Parameters<typeof baseFn>[0],
      {} as Parameters<typeof baseFn>[1],
      { signal: callerAbortController.signal },
    );

    callerAbortController.abort(callerReason);

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: callerReason.message,
      cause: callerReason,
    });
    await vi.advanceTimersByTimeAsync(50);
    const providerSignal = (
      baseFnMock.mock.calls.at(0)?.[2] as { signal?: AbortSignal } | undefined
    )?.signal;
    expect([providerSignal?.reason, onIdleTimeout.mock.calls.length]).toEqual([callerReason, 0]);
  });
  it.each([true, false])(
    "observes late provider creation rejection when pre-aborted is %s",
    async (preAborted) => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled before provider settled");
      let rejectProvider!: (error: Error) => void;
      const providerPromise = new Promise<AssistantMessageEventStream>((_resolve, reject) => {
        rejectProvider = reject;
      });
      const baseFn = vi.fn(() => providerPromise);
      if (preAborted) {
        controller.abort(reason);
      }
      const pending = streamWithIdleTimeout(baseFn, 50)(
        {} as Parameters<Parameters<typeof streamWithIdleTimeout>[0]>[0],
        {} as Parameters<Parameters<typeof streamWithIdleTimeout>[0]>[1],
        { signal: controller.signal },
      );
      if (!preAborted) {
        controller.abort(reason);
      }
      await expect(pending).rejects.toMatchObject({ name: "AbortError", cause: reason });
      expect(baseFn).toHaveBeenCalledOnce();
      rejectProvider(new Error("late provider creation rejection"));
      // Let Node report any unowned rejection to the native test runner.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  );
});
