import { expect, it, vi } from "vitest";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { deliverAgentCommandResult } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(async () => []),
  deliverOutboundPayloadsInternal: vi.fn(async () => []),
}));

vi.mock("../../auto-reply/reply/reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: vi.fn(() => async (payload: unknown) => payload),
}));

it("preserves Finn request evidence in the agent JSON envelope", async () => {
  const runtime = { log: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
  const agentMeta = {
    sessionId: "session-1",
    provider: "local",
    model: "qwen",
    finnRequestIds: ["req_cli-42"],
    finnRequestIdEvidenceComplete: true,
  };

  const delivered = await deliverAgentCommandResult({
    cfg: {} as OpenClawConfig,
    deps: {} as CliDeps,
    runtime: runtime as never,
    opts: {
      message: "test",
      json: true,
      resultMetaOverrides: { transport: "embedded", fallbackFrom: "gateway" },
    } as AgentCommandOpts,
    outboundSession: undefined,
    sessionEntry: undefined,
    payloads: [{ text: "local" }],
    result: { meta: { durationMs: 1, agentMeta } } as never,
  });

  expect(runtime.writeJson).toHaveBeenCalledWith(
    {
      payloads: [{ text: "local", mediaUrl: null }],
      meta: {
        durationMs: 1,
        agentMeta,
        transport: "embedded",
        fallbackFrom: "gateway",
      },
    },
    2,
  );
  expect(delivered.meta.agentMeta).toEqual(agentMeta);
});
