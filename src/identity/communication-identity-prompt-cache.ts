import { createHash } from "node:crypto";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Derive an opaque cache partition for a single agent session and model.
 *
 * Agent identity is included even though session ids are normally unique. This
 * makes cache isolation fail closed if a stale or imported session id is ever
 * reused under another communication identity. Provider/model are included so
 * a fallback cannot inherit cache state produced by a different runtime.
 */
export function resolveCommunicationIdentityPromptCacheKey(params: {
  agentId?: string;
  sessionKey: string;
  provider: string;
  model: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "communication-identity-v1",
        normalizeAgentId(params.agentId),
        params.sessionKey.trim(),
        params.provider.trim().toLowerCase(),
        params.model.trim(),
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
  return `openclaw-identity-${digest}`;
}
