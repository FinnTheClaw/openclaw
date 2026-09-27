/** Closed, host-owned disposable tools for the first live governor loop canary. */
import { Type } from "typebox";
import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { stringEnum } from "../agents/schema/typebox.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";

export type GovernorAgentLoopToolImplementationId =
  | "disposable-aggregate-v1"
  | "disposable-observation-fail-once-v1"
  | "disposable-observation-v1"
  | "installed-tool:exec"
  | "installed-tool:read";

const IMPLEMENTATION_IDS = new Set<GovernorAgentLoopToolImplementationId>([
  "disposable-aggregate-v1",
  "disposable-observation-fail-once-v1",
  "disposable-observation-v1",
  "installed-tool:exec",
  "installed-tool:read",
]);
type GovernorAgentLoopToolIdentity = Readonly<{
  implementationId: GovernorAgentLoopToolImplementationId;
  toolName: string;
}>;

const HOST_TOOLS = new WeakMap<object, GovernorAgentLoopToolIdentity>();

export function isGovernorAgentLoopToolImplementationId(
  value: string,
): value is GovernorAgentLoopToolImplementationId {
  return IMPLEMENTATION_IDS.has(value as GovernorAgentLoopToolImplementationId);
}

export function governorAgentLoopToolImplementationDigest(
  implementationId: GovernorAgentLoopToolImplementationId,
): string {
  return governorDigest({ implementationId, moduleVersion: 1, authority: "compiled-host" });
}

export function createGovernorAgentLoopTool(params: {
  toolName: string;
  implementationId: GovernorAgentLoopToolImplementationId;
  purpose?: string;
  argumentName?: string;
  allowedArgumentValues?: readonly string[];
}): AgentTool {
  let failed = false;
  const execute: AgentTool["execute"] = async (_callId, input) => {
    const record =
      typeof input === "object" && input !== null
        ? (input as Readonly<Record<string, unknown>>)
        : undefined;
    const argumentName = params.argumentName ?? "key";
    const key = typeof record?.[argumentName] === "string" ? record[argumentName] : "none";
    if (params.implementationId === "disposable-observation-fail-once-v1" && !failed) {
      failed = true;
      throw new Error("GOVERNOR_DISPOSABLE_OBSERVATION_RETRY");
    }
    const text =
      params.implementationId === "disposable-aggregate-v1" ? "42" : `observation:${key}`;
    return { content: [{ type: "text", text }], details: null };
  };
  const argumentSchema = params.argumentName
    ? Type.Object(
        {
          [params.argumentName]: params.allowedArgumentValues?.length
            ? stringEnum(params.allowedArgumentValues, {
                description: `Allowed values: ${params.allowedArgumentValues.join(", ")}`,
              })
            : Type.String({ maxLength: 256 }),
        },
        { additionalProperties: false },
      )
    : Type.Object({}, { additionalProperties: false });
  const tool: AgentTool = Object.freeze({
    name: params.toolName,
    label: params.toolName,
    description: params.purpose
      ? `Host-owned governed action: ${params.purpose}`
      : "Host-owned governed action",
    parameters: argumentSchema,
    executionMode: "sequential" as const,
    execute,
  });
  HOST_TOOLS.set(
    tool,
    Object.freeze({ toolName: params.toolName, implementationId: params.implementationId }),
  );
  return tool;
}

export function matchesHostGovernorAgentLoopTool(
  tool: AgentTool,
  expected: GovernorAgentLoopToolIdentity,
): boolean {
  const identity = HOST_TOOLS.get(tool);
  return (
    identity?.toolName === expected.toolName &&
    identity.implementationId === expected.implementationId
  );
}
