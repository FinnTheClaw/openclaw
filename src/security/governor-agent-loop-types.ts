import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { GovernorAgentLoopMode } from "./governor-agent-loop-config.js";

export type GovernorAgentLoopRunInput = Readonly<{
  runId: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  channel: string;
  accountId: string;
  principalId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceSequence?: number;
  prompt: string;
  now: number;
}>;

export type GovernorAgentLoopToolTicket = Readonly<{ opaque: object }>;
export type GovernorAgentLoopToolDecision =
  | { kind: "allow"; ticket?: GovernorAgentLoopToolTicket }
  | { kind: "block"; reasonCode: string };
export type GovernorAgentLoopTurnDecision =
  | { kind: "complete" }
  | { kind: "continue"; message: string }
  | { kind: "stop"; reasonCode: string };

export type GovernorAgentLoopRunScope = Readonly<{
  taskId: string;
  mode: GovernorAgentLoopMode;
  beforeTool(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    tool: AgentTool | undefined;
    now: number;
  }): GovernorAgentLoopToolDecision;
  afterTool(input: {
    ticket?: GovernorAgentLoopToolTicket;
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
    now: number;
  }): void;
  afterTurn(input: {
    assistantText: string;
    assistantStopReason?: string;
    toolCallCount: number;
    now: number;
  }): GovernorAgentLoopTurnDecision;
  interrupt(input: { now: number }): void;
  assertTerminal(): void;
  governedTools(): readonly AgentTool[];
  dispose(): void;
}>;
