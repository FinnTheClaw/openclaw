import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const pull = vi.hoisted(() => vi.fn());
const advance = vi.hoisted(() => vi.fn());
const readCursor = vi.hoisted(() => vi.fn());
const createHandler = vi.hoisted(() => vi.fn());
vi.mock("./functional-finn-ingress-client.js", () => ({
  pullFunctionalFinnIngress: (...args: unknown[]) => pull(...args),
}));
vi.mock("./functional-finn-ingress-cursor.js", () => ({
  advanceFunctionalFinnIngressCursor: (...args: unknown[]) => advance(...args),
  readFunctionalFinnIngressCursor: (...args: unknown[]) => readCursor(...args),
}));
vi.mock("./monitor/event-handler.js", () => ({
  createSignalEventHandler: (...args: unknown[]) => createHandler(...args),
}));

const { monitorProtectedFunctionalFinnSignal } = await import("./monitor-protected.js");

function config() {
  return {
    channels: {
      signal: {
        accounts: {
          finn: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "disabled",
            functionalFinnExternalAuthority: {
              enabled: true,
              agentId: "finn-agent",
              candidateSocketPath: "/private/run/finnrel.sock",
              ingressSocketPath: "/private/run/finnsig.sock",
              timeoutMs: 500,
              protectedTransport: true,
            },
          },
        },
      },
    },
  } as never;
}

describe("protected Functional Finn Signal monitor", () => {
  it("pulls trusted ingress, awaits ordinary handler completion, then advances cursor", async () => {
    const abort = new AbortController();
    const handled: unknown[] = [];
    readCursor.mockReturnValue(undefined);
    pull.mockResolvedValueOnce([
      {
        ingressId: "ingress-1",
        bindingId: "binding-1",
        accountId: "finn",
        sourceId: "source-1",
        sourceKind: "uuid",
        conversationId: "conversation-1",
        conversationKind: "direct",
        ordinal: 1,
        sequence: 4,
        receivedAt: 100,
        contentDigest: "a".repeat(64),
        content: "Observed fact.",
      },
    ]);
    createHandler.mockReturnValue(async (event: unknown) => {
      handled.push(event);
      abort.abort();
    });
    await monitorProtectedFunctionalFinnSignal({
      config: config(),
      accountId: "finn",
      abortSignal: abort.signal,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      event: "receive",
      trustedIngress: {
        agentId: "finn-agent",
        ingressId: "ingress-1",
        bindingId: "binding-1",
      },
    });
    expect(advance).toHaveBeenCalledOnce();
    expect(createHandler.mock.calls[0]?.[0]).toMatchObject({
      transportFeedbackEnabled: false,
      sendReadReceipts: false,
      ignoreAttachments: true,
    });
  });

  it("has no direct daemon, SSE, HTTP, or Signal RPC import", () => {
    const source = readFileSync("extensions/signal/src/monitor-protected.ts", "utf8");
    expect(source).not.toMatch(/client-adapter|spawnSignalDaemon|sse-reconnect|signalRpcRequest/);
  });
});
