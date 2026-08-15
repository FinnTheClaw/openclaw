import { createHash } from "node:crypto";
import type { FunctionalFinnConfig } from "./config.js";
import { classifyFunctionalFinnRequest } from "./request-classifier.js";

type AdmissionEvent = { prompt: string; channelId?: string };
type AdmissionContext = { agentId?: string; channel?: string; sessionKey?: string };
type AdmissionDecision =
  | { outcome: "pass" }
  | { outcome: "block"; reason: string; category: string };

export type FunctionalFinnGoalEnsure = (params: {
  sessionKey: string;
  objective: string;
}) => Promise<unknown>;

function objectiveFor(prompt: string): string {
  const digest = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
  return `Complete substantive user request [sha256:${digest}]`;
}

export function createFunctionalFinnAdmission(params: {
  config: FunctionalFinnConfig;
  ensureGoal: FunctionalFinnGoalEnsure;
}): (event: AdmissionEvent, context: AdmissionContext) => Promise<AdmissionDecision> {
  return async (event, context) => {
    const channel = context.channel ?? event.channelId;
    if (
      !context.agentId ||
      !channel ||
      !params.config.agentIds.includes(context.agentId) ||
      !params.config.channels.includes(channel)
    ) {
      return { outcome: "pass" };
    }
    if (classifyFunctionalFinnRequest(event.prompt) === "trivial") {
      return { outcome: "pass" };
    }
    if (!context.sessionKey) {
      return {
        outcome: "block",
        reason: "substantive request has no durable session identity",
        category: "functional_finn_goal_unavailable",
      };
    }
    await params.ensureGoal({
      sessionKey: context.sessionKey,
      objective: objectiveFor(event.prompt),
    });
    return { outcome: "pass" };
  };
}
