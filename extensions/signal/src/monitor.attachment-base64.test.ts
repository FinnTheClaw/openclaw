import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalEventHandlerDeps } from "./monitor/event-handler.types.js";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const saveMediaBufferMock = vi.hoisted(() => vi.fn());
let capturedFetchAttachment: SignalEventHandlerDeps["fetchAttachment"] | undefined;

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, saveMediaBuffer: saveMediaBufferMock };
});

vi.mock("./client-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("./client-adapter.js")>("./client-adapter.js");
  return { ...actual, signalRpcRequest: signalRpcRequestMock };
});

vi.mock("./monitor/event-handler.js", () => ({
  createSignalEventHandler: (deps: SignalEventHandlerDeps) => {
    capturedFetchAttachment = deps.fetchAttachment;
    return async () => {};
  },
}));
vi.mock("./signal-ingress.js", () => ({
  startSignalIngressMonitor: async () => ({ receive: async () => {}, stop: async () => {} }),
}));
vi.mock("./sse-reconnect.js", () => ({ runSignalSseLoop: async () => {} }));

const { monitorSignalProvider } = await import("./monitor.js");
const config = {
  channels: {
    signal: {
      transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
} satisfies OpenClawConfig;

describe("Signal attachment fetch", () => {
  beforeEach(() => {
    capturedFetchAttachment = undefined;
    signalRpcRequestMock.mockReset();
    saveMediaBufferMock.mockReset().mockResolvedValue({
      path: "/tmp/signal-attachment.png",
      contentType: "image/png",
    });
  });

  it("rejects malformed base64 attachment data before persisting it", async () => {
    signalRpcRequestMock.mockResolvedValue({ data: "aGVs%%%bG8=" });
    await monitorSignalProvider({ config, autoStart: false });
    if (!capturedFetchAttachment) {
      throw new Error("expected monitor to configure fetchAttachment");
    }

    await expect(
      capturedFetchAttachment({
        baseUrl: "http://127.0.0.1:8080",
        attachment: { id: "attachment-123", contentType: "image/png" },
        sender: "+15550001111",
        maxBytes: 8 * 1024 * 1024,
      }),
    ).rejects.toThrow("Signal attachment attachment-123 returned malformed base64 data");
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });
});
