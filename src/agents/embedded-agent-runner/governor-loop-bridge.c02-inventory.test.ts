import { describe, expect, it, vi } from "vitest";
import type { StreamFn } from "../../../packages/agent-core/src/types.js";
import {
  governorAgentLoopAssistant,
  governorAgentLoopFixtureModel,
  governorAgentLoopScriptedStream,
  governorAgentLoopTool,
} from "../../../test/helpers/governor-agent-loop.js";
import type { GovernorAgentLoopRunScope } from "../../security/governor-agent-loop-readonly.js";
import { Agent } from "../runtime/index.js";
import { installGovernorLoopBridge } from "./governor-loop-bridge.js";

describe("C02 governor tool inventory", () => {
  it("updates the next provider turn to the newly eligible governed tool", async () => {
    const read = governorAgentLoopTool("read", async () => ({ content: [], details: null }));
    const exec = governorAgentLoopTool("exec", async () => ({ content: [], details: null }));
    let tools = [read];
    let turn = 0;
    const providerToolNames: string[][] = [];
    const scripted = governorAgentLoopScriptedStream(() => {
      turn += 1;
      if (turn === 1) {
        return governorAgentLoopAssistant([
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ]);
      }
      if (turn === 2) {
        return governorAgentLoopAssistant([
          { type: "toolCall", id: "exec-1", name: "exec", arguments: {} },
        ]);
      }
      return governorAgentLoopAssistant([{ type: "text", text: "C02_COMPLETE" }]);
    });
    const streamFn: StreamFn = (model, context, options) => {
      providerToolNames.push((context.tools ?? []).map((tool) => tool.name));
      return scripted(model, context, options);
    };
    const scope: GovernorAgentLoopRunScope = {
      taskId: "c02-eval-session:C02-A-001:0123456789abcdef01234567",
      mode: "enforce",
      beforeTool: vi.fn(() => ({ kind: "allow" })),
      afterTool: vi.fn((input) => {
        if (input.toolName === "read") {
          tools = [exec];
        }
      }),
      afterTurn: vi.fn((input) =>
        input.toolCallCount > 0 ? { kind: "continue", message: "continue" } : { kind: "complete" },
      ),
      interrupt: vi.fn(),
      assertTerminal: vi.fn(),
      governedTools: vi.fn(() => tools),
      dispose: vi.fn(),
    };
    const agent = new Agent({
      initialState: { model: governorAgentLoopFixtureModel, tools: [read, exec] },
      streamFn,
    });
    const bridge = installGovernorLoopBridge({ agent, scope });

    await agent.prompt("complete C02");

    expect(providerToolNames).toEqual([["read"], ["exec"], ["exec"]]);
    expect(scope.afterTool).toHaveBeenCalledTimes(2);
    bridge.assertTerminal();
    bridge.dispose();
  });
});
