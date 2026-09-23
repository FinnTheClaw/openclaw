import { describe, expect, it } from "vitest";
import { resolveTargetAcpAgentId } from "./acp-spawn-target.js";

describe("resolveTargetAcpAgentId", () => {
  it.each(["", "   ", "агент✨", "---"])(
    "rejects explicit unrepresentable ACP agent id %j",
    (agentId) => {
      expect(
        resolveTargetAcpAgentId({
          requestedAgentId: agentId,
          cfg: { acp: { defaultAgent: "codex" } },
        }),
      ).toEqual({ ok: false, error: `agentId "${agentId}" was not found` });
    },
  );

  it("keeps omitted ACP agent ids on the configured default path", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: { acp: { defaultAgent: "codex" } },
      }),
    ).toEqual({ ok: true, agentId: "codex" });
  });

  it("maps an omitted default config-agent id to its ACP harness id", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "reviewer" },
          agents: { list: [{ id: "reviewer", runtime: { type: "acp", acp: { agent: "codex" } } }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "codex", configAgentId: "reviewer" });
  });

  it("uses the mapped default config-agent backend override", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "reviewer", backend: "global" },
          agents: {
            list: [
              {
                id: "reviewer",
                runtime: { type: "acp", acp: { agent: "codex", backend: "special" } },
              },
            ],
          },
        },
      }),
    ).toEqual({ ok: true, agentId: "codex", configAgentId: "reviewer", backendId: "special" });
  });

  it("falls back to the global backend for a mapped default config agent", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "reviewer", backend: "global" },
          agents: { list: [{ id: "reviewer", runtime: { type: "acp", acp: { agent: "codex" } } }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "codex", configAgentId: "reviewer", backendId: "global" });
  });

  it("retains the config id when its ACP mapping omits a harness id", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "reviewer" },
          agents: { list: [{ id: "reviewer", runtime: { type: "acp" } }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "reviewer", configAgentId: "reviewer" });
  });

  it("normalizes an omitted default config-agent id before mapping it", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "  REVIEWER  " },
          agents: { list: [{ id: "reviewer", runtime: { type: "acp", acp: { agent: "codex" } } }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "codex", configAgentId: "reviewer" });
  });

  it("keeps a direct default harness id free of config-agent attribution", () => {
    expect(resolveTargetAcpAgentId({ cfg: { acp: { defaultAgent: "codex" } } })).toEqual({
      ok: true,
      agentId: "codex",
    });
  });

  it("preserves explicit config-agent mapping and attribution", () => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "reviewer",
        cfg: {
          agents: { list: [{ id: "reviewer", runtime: { type: "acp", acp: { agent: "codex" } } }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "codex", configAgentId: "reviewer" });
  });

  it("preserves explicit direct harness id behavior", () => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: "codex",
        cfg: { acp: { defaultAgent: "reviewer" } },
      }),
    ).toEqual({ ok: true, agentId: "codex" });
  });

  it("rejects an omitted default that names an unallowed non-ACP config agent", () => {
    const result = resolveTargetAcpAgentId({
      cfg: { acp: { defaultAgent: "reviewer" }, agents: { list: [{ id: "reviewer" }] } },
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('agentId "reviewer" is an OpenClaw config agent'),
    });
  });

  it("preserves explicitly allowed default config ids as direct harness ids", () => {
    expect(
      resolveTargetAcpAgentId({
        cfg: {
          acp: { defaultAgent: "reviewer", allowedAgents: ["reviewer"] },
          agents: { list: [{ id: "reviewer" }] },
        },
      }),
    ).toEqual({ ok: true, agentId: "reviewer", configAgentId: "reviewer" });
  });
});
