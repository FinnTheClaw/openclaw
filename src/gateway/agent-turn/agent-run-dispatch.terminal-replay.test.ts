import { beforeEach, describe, expect, it, vi } from "vitest";
import { readGatewayDedupeEntry } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";

const agentCommandFromGatewayIngress = vi.hoisted(() => vi.fn());
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress }));

describe("agent dispatch terminal replay", () => {
  beforeEach(() => agentCommandFromGatewayIngress.mockReset());

  it.each([
    { aborted: true, settled: false },
    { aborted: true, settled: true },
    { aborted: false, settled: false },
    { aborted: false, settled: true },
  ])(
    "replays the same terminal response after aborted=$aborted settlement=$settled",
    async ({ aborted, settled }) => {
      const controller = new AbortController();
      if (aborted) {
        controller.abort();
      }
      agentCommandFromGatewayIngress.mockRejectedValueOnce(
        aborted ? controller.signal.reason : new Error("provider failed"),
      );
      const dedupe = new Map();
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        ingressOpts: { message: "continue", runId: "cancelled-replay" },
        runId: "cancelled-replay",
        dedupeKeys: ["agent:cancelled-replay"],
        abortController: controller,
        cleanupAbortController: vi.fn(),
        io: { emitFinal, emitAcceptance: vi.fn() },
        context: {
          dedupe,
          chatAbortControllers: new Map(),
          deps: {},
          logGateway: { warn: vi.fn() },
        },
        taskTrackingMode: "none",
        onSettled: async () => settled,
      } as unknown as Parameters<typeof dispatchAgentRunFromGateway>[0]);
      expect(emitFinal).toHaveBeenCalledTimes(1);
      const terminal = emitFinal.mock.calls[0]![0];
      expect(terminal[0]).toBe(aborted && settled);
      if (!aborted || !settled) {
        expect(terminal[2]).toBeDefined();
      }
      const cached = readGatewayDedupeEntry({ dedupe, keys: ["agent:cancelled-replay"] });
      expect(cached).toBeDefined();
      expect([cached?.ok, cached?.payload, cached?.error]).toEqual(terminal);
    },
  );
});
