import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function toolNames(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>): string[] {
  return createOpenClawTools({
    config: {} as OpenClawConfig,
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
  }).map((tool) => tool.name);
}

describe("communication_access registration", () => {
  it("registers for an authenticated owner channel and a local main session", () => {
    expect(
      toolNames({
        agentSessionKey: "agent:finn:signal:direct:fake-owner-9113",
        agentChannel: "signal",
        senderIsOwner: true,
      }),
    ).toContain("communication_access");
    expect(toolNames({ agentSessionKey: "agent:finn:main" })).toContain("communication_access");
  });

  it("excludes non-owners, sandboxes, quarantine, and local subagents", () => {
    const cases: Array<NonNullable<Parameters<typeof createOpenClawTools>[0]>> = [
      {
        agentSessionKey: "agent:person-fake:signal:direct:fake-member-7255",
        agentChannel: "signal",
        senderIsOwner: false,
      },
      {
        agentSessionKey: "agent:finn:signal:direct:fake-owner-9113",
        agentChannel: "signal",
        senderIsOwner: true,
        sandboxed: true,
      },
      {
        agentSessionKey: "agent:communication-quarantine:signal:direct:fake-unknown-7255",
        senderIsOwner: true,
      },
      { agentSessionKey: "agent:finn:subagent:fake-child" },
    ];

    for (const options of cases) {
      expect(toolNames(options)).not.toContain("communication_access");
    }
  });
});
