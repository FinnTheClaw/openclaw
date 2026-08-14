import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

function makeStreamFn() {
  return vi.fn(async function* () {
    yield { type: "text", text: "ok" };
  } as unknown as StreamFn);
}

function wrap(streamFn: StreamFn, authorizeProviderStart: () => Promise<boolean>) {
  return wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
    runId: "auth-run",
    provider: "test-provider",
    model: "test-model",
    trace: createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    }),
    nextCallId: () => "auth-run:model:1",
    onBeforeProviderStart: authorizeProviderStart,
  });
}

describe("embedded provider start authorization", () => {
  it("rejects before streamFn when the durable fence loses", async () => {
    const streamFn = makeStreamFn();
    const authorize = vi.fn(async () => false);
    const wrapped = wrap(streamFn, authorize);

    await expect(
      wrapped({} as never, {} as never, {} as never) as Promise<unknown>,
    ).rejects.toThrow("provider start was denied");
    expect(authorize).toHaveBeenCalledOnce();
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("authorizes before invoking the provider stream", async () => {
    const streamFn = makeStreamFn();
    let streamAuthorized = false;
    const wrapped = wrap(streamFn, async () => {
      streamAuthorized = true;
      return true;
    });

    const result = await wrapped({} as never, {} as never, {} as never);
    expect(streamAuthorized).toBe(true);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
  });
});
