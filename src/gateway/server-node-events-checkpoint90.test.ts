import { describe, expect, it, vi } from "vitest";
import type { NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

type Command = {
  runId: string;
  sessionId: string;
  sessionKey: string;
  message: string;
  deliver?: boolean;
};
const cases: Array<{
  name: string;
  keys: readonly [string, string];
  rejectFirst?: boolean;
}> = [
  { name: "two-requests-one-session-distinct-runs", keys: ["agent:main:a", "agent:main:a"] },
  { name: "two-requests-stable-session", keys: ["agent:main:a", "agent:main:a"] },
  { name: "different-sessions-distinct-runs", keys: ["agent:main:a", "agent:main:b"] },
  { name: "first-stream-ownership", keys: ["agent:main:a", "agent:main:a"] },
  { name: "second-stream-ownership", keys: ["agent:main:a", "agent:main:a"] },
  { name: "first-cancel-does-not-cancel-second", keys: ["agent:main:a", "agent:main:a"] },
  { name: "second-cancel-does-not-cancel-first", keys: ["agent:main:a", "agent:main:a"] },
  { name: "voice-run-id-control", keys: ["agent:main:a", "agent:main:b"] },
  { name: "reconnect-same-session-new-run", keys: ["agent:main:a", "agent:main:a"] },
  {
    name: "rejected-request-does-not-collide-next",
    keys: ["agent:main:a", "agent:main:a"],
    rejectFirst: true,
  },
] as const;

describe("checkpoint-90 node request run identity", () => {
  it.each(cases)("$name", async ({ keys, rejectFirst }) => {
    const dispatched: Command[] = [];
    const ctx = {
      deps: {},
      logGateway: { warn: vi.fn() },
      loadGatewayModelCatalog: async () => [],
    } as unknown as NodeEventContext;
    const dependencies = {
      getRuntimeConfig: () => ({ session: { mainKey: "agent:main:main" } }),
      loadSessionEntry: (key: string) => ({
        storePath: "",
        canonicalKey: key,
        entry: { sessionId: `sid-${key}` },
      }),
      normalizeRpcAttachmentsToChatAttachments: () => [],
      normalizeChannelId: (value: string) => value || null,
      persistInboundImagesForTranscript: async () => ({ entries: [], omission: "none" }),
      agentCommandFromIngress: async (input: Command) => {
        dispatched.push(input);
      },
      defaultRuntime: {},
      formatForLog: String,
      INLINE_IMAGE_DURABLE_OMISSION_MARKER: "[omitted]",
    } as unknown as NonNullable<Parameters<typeof handleNodeEvent>[4]>;
    const submit = (key: string, message: string) =>
      handleNodeEvent(
        ctx,
        "node-checkpoint90",
        { event: "agent.request", payloadJSON: JSON.stringify({ sessionKey: key, message }) },
        undefined,
        dependencies,
      );
    if (rejectFirst) {
      await submit(keys[0], "");
    } else {
      await submit(keys[0], "first");
    }
    await submit(keys[1], "second");
    await vi.waitFor(() => expect(dispatched).toHaveLength(rejectFirst ? 1 : 2), { interval: 1 });
    if (rejectFirst) {
      expect(dispatched[0]?.message).toBe("second");
      expect(dispatched[0]?.runId).not.toBe(dispatched[0]?.sessionId);
      return;
    }
    const [first, second] = dispatched;
    expect(first?.runId).toBeTruthy();
    expect(second?.runId).toBeTruthy();
    expect(first?.runId).not.toBe(second?.runId);
    expect(first?.runId).not.toBe(first?.sessionId);
    expect(second?.runId).not.toBe(second?.sessionId);
    expect(first?.sessionId).toBe(`sid-${keys[0]}`);
    expect(second?.sessionId).toBe(`sid-${keys[1]}`);
    expect(first?.sessionKey).toBe(keys[0]);
    expect(second?.sessionKey).toBe(keys[1]);
  });
});
