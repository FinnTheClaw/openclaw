import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { describeAcpSpawnTargetParameter, resolveTargetAcpAgentId } from "./acp-spawn-target.js";

const coder = { runtime: { type: "acp" as const } };
const defaultAcp = { defaultAgent: "codex" };
const required = "agentId is required.";
const defaultNote = 'Omit to use the configured ACP default ("codex").';
const none = `No ACP harness id is allowed. ${required}`;
const example = (ids: string, suffix = required) =>
  `ACP harness id, for example: ${ids}. ${suffix}`;
function config(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  acp?: OpenClawConfig["acp"],
): OpenClawConfig {
  return { agents: { entries }, ...(acp ? { acp } : {}) };
}

describe("resolveTargetAcpAgentId", () => {
  it.each(["", "агент✨"])("rejects explicit unrepresentable ACP agent id %j", (agentId) => {
    expect(
      resolveTargetAcpAgentId({
        requestedAgentId: agentId,
        cfg: { acp: { defaultAgent: "codex" } },
      }),
    ).toEqual({ ok: false, error: `agentId "${agentId}" was not found` });
  });
});

describe("describeAcpSpawnTargetParameter", () => {
  it.each([
    ["empty registry", config({}), example("codex, claude")],
    ["configured default", config({}, defaultAcp), example("codex", defaultNote)],
    [
      "native agent exclusion",
      config({ main: {}, coder }, defaultAcp),
      example("coder, codex", defaultNote),
    ],
    ["native example exclusion", config({ codex: {} }), example("claude")],
    ["all examples excluded", config({ codex: {}, claude: {} }), `ACP harness id. ${required}`],
    [
      "disallowed default",
      config({ main: {} }, { allowedAgents: ["codex", "claude"], defaultAgent: "gemini" }),
      `ACP harness id from: claude, codex. ${required}`,
    ],
    ["non-granting wildcard", config({}, { allowedAgents: ["*"], ...defaultAcp }), none],
  ] satisfies Array<[string, OpenClawConfig, string]>)("describes %s", (_label, cfg, expected) => {
    expect(describeAcpSpawnTargetParameter(cfg)).toBe(expected);
  });

  describe("for a subagent requester", () => {
    it.each([
      ["requester only", config({ main: {}, coder }, defaultAcp), none],
      [
        "requester allowlist",
        config({ main: { subagents: { allowAgents: ["codex"] } }, coder }, defaultAcp),
        `ACP harness id from: codex. ${defaultNote}`,
      ],
      [
        "explicit target required",
        {
          ...config({ main: {}, coder }, defaultAcp),
          agents: {
            entries: { main: {}, coder },
            defaults: { subagents: { allowAgents: ["*"], requireAgentId: true } },
          },
        },
        `ACP harness id from: coder, codex. ${required}`,
      ],
    ] satisfies Array<[string, OpenClawConfig, string]>)(
      "describes %s",
      (_label, cfg, expected) => {
        expect(describeAcpSpawnTargetParameter(cfg, "main")).toBe(expected);
      },
    );
  });

  describe("for a sender-restricted session", () => {
    const cfg = config({ main: {}, coder });
    const sender = { requesterAgentId: "main", inheritedToolPolicySource: "sender" as const };

    it("offers no harness other than the requester", () => {
      expect(
        describeAcpSpawnTargetParameter(
          { ...cfg, acp: { defaultAgent: "codex" } },
          undefined,
          sender,
        ),
      ).toBe(none);
    });

    it("omits aliases whose requested id the sender check rejects", () => {
      const aliased = {
        acp: { allowedAgents: ["main"] },
        agents: {
          entries: {
            main: {},
            coder: { runtime: { type: "acp" as const, acp: { agent: "main" } } },
          },
        },
      };
      expect(
        describeAcpSpawnTargetParameter(aliased, "main", {
          ...sender,
          workspaceDir: "/work",
        }),
      ).toBe("ACP harness id from: main. agentId is required.");
    });
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
