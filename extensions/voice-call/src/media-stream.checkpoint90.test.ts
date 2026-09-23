import type { RealtimeTranscriptionSessionCreateRequest } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler } from "./media-stream.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

const cases = [
  ["P01 single normal stream", "single"],
  ["P02 same-socket duplicate start", "same-socket"],
  ["P03 second-socket duplicate rejected", "duplicate"],
  ["P04 first routable after rejected duplicate closes", "first-routable"],
  ["P05 SID reuse after first closes", "reuse"],
  ["P06 distinct SID concurrency", "distinct"],
  ["P07 same SID other call rejected", "other-call"],
  ["P08 invalid-token duplicate rejected", "invalid-token"],
  ["P09 rejected socket has no routed callbacks", "no-callbacks"],
  ["P10 old stop cannot delete legitimately reused session", "stale-stop"],
] as const;

function start(ws: WebSocket, sid: string, call: string, token = "valid") {
  ws.send(
    JSON.stringify({
      event: "start",
      streamSid: sid,
      start: { callSid: call, customParameters: { token } },
    }),
  );
}

function active(handler: MediaStreamHandler): Map<string, unknown> {
  return (handler as unknown as { sessions: Map<string, unknown> }).sessions;
}

describe("CH02 duplicate media stream identity", () => {
  it.each(cases)("%s", async (_name, mode) => {
    const created: RealtimeTranscriptionSessionCreateRequest[] = [];
    const createSession = vi.fn((request: RealtimeTranscriptionSessionCreateRequest) => {
      created.push(request);
      return {
        connect: async () => {},
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => true,
      };
    });
    const shouldAcceptStream = vi.fn(({ token }: { token?: string }) => token === "valid");
    const onConnect = vi.fn();
    const onTranscript = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream,
      onConnect,
      onTranscript,
    });
    const server = await startUpgradeWsServer({
      urlPath: "/voice/stream",
      onUpgrade: (request, socket, head) => handler.handleUpgrade(request, socket, head),
    });
    const sockets: WebSocket[] = [];
    try {
      const first = await connectWs(server.url);
      sockets.push(first);
      start(first, "MZ-shared", "CA-first");
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith("CA-first", "MZ-shared"));
      const firstSession = active(handler).get("MZ-shared");
      expect(firstSession).toBeDefined();

      if (mode === "single") {
        expect(createSession).toHaveBeenCalledTimes(1);
        expect(active(handler).size).toBe(1);
        return;
      }
      if (mode === "same-socket") {
        const closed = waitForClose(first);
        start(first, "MZ-other", "CA-other");
        expect(await closed).toEqual({ code: 1008, reason: "Duplicate start" });
        expect(createSession).toHaveBeenCalledTimes(1);
        return;
      }
      if (mode === "reuse" || mode === "stale-stop") {
        const closed = waitForClose(first);
        first.close();
        await closed;
        await vi.waitFor(() => expect(active(handler).has("MZ-shared")).toBe(false));
        const second = await connectWs(server.url);
        sockets.push(second);
        start(second, "MZ-shared", "CA-second");
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith("CA-second", "MZ-shared"));
        expect(createSession).toHaveBeenCalledTimes(2);
        if (mode === "stale-stop") {
          (handler as unknown as { handleStop: (session: unknown) => void }).handleStop(
            firstSession,
          );
          expect(active(handler).get("MZ-shared")).not.toBe(firstSession);
        }
        return;
      }
      const second = await connectWs(server.url);
      sockets.push(second);
      if (mode === "distinct") {
        start(second, "MZ-distinct", "CA-second");
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith("CA-second", "MZ-distinct"));
        expect(active(handler).size).toBe(2);
        expect(createSession).toHaveBeenCalledTimes(2);
        return;
      }
      const closed = waitForClose(second);
      start(
        second,
        "MZ-shared",
        mode === "other-call" ? "CA-other" : "CA-first",
        mode === "invalid-token" ? "invalid" : "valid",
      );
      expect(await closed).toEqual({ code: 1008, reason: "Duplicate streamSid" });
      expect(active(handler).get("MZ-shared")).toBe(firstSession);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(shouldAcceptStream).toHaveBeenCalledTimes(1);
      if (mode === "first-routable") {
        created[0]?.onTranscript?.("hello");
        expect(onTranscript).toHaveBeenCalledWith("CA-first", "hello", "MZ-shared");
      }
      if (mode === "no-callbacks") {
        expect(onConnect).toHaveBeenCalledTimes(1);
        expect(created).toHaveLength(1);
      }
    } finally {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.terminate();
        }
      }
      await handler.close();
      await server.close();
    }
  });
});
