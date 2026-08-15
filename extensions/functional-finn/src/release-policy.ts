import { createHash } from "node:crypto";
import { parseFunctionalFinnAnswerEnvelope } from "./answer-envelope.js";
import type { FunctionalFinnConfig } from "./config.js";
import type { FunctionalFinnEvidenceStore } from "./evidence-store.js";
import type {
  FunctionalFinnVerifierRequest,
  FunctionalFinnVerifierResponse,
} from "./verifier-client.js";

type SessionBinding = { agentId: string; channel: string };
type SyncStore<T> = {
  register: (key: string, value: T, options?: { ttlMs?: number }) => void;
  lookup: (key: string) => T | undefined;
};

export type FunctionalFinnVerifier = (
  request: Extract<FunctionalFinnVerifierRequest, { operation: "validate" | "authorize" }>,
) => Promise<FunctionalFinnVerifierResponse>;

export function createFunctionalFinnReleasePolicy(params: {
  config: FunctionalFinnConfig;
  sessions: SyncStore<SessionBinding>;
  revisions: SyncStore<{ requested: true }>;
  evidence: FunctionalFinnEvidenceStore;
  verify: FunctionalFinnVerifier;
}) {
  const isProtected = (sessionKey?: string, channel?: string) => {
    const binding = sessionKey ? params.sessions.lookup(sessionKey) : undefined;
    return Boolean(
      binding &&
      params.config.agentIds.includes(binding.agentId) &&
      params.config.channels.includes(channel ?? binding.channel),
    );
  };

  const verifierRequest = (input: {
    operation: "validate" | "authorize";
    text: string;
    sessionKey: string;
    runId: string;
    accountId?: string;
    target?: string;
    revision?: 0 | 1;
  }):
    | Extract<FunctionalFinnVerifierRequest, { operation: "validate" | "authorize" }>
    | undefined => {
    const binding = params.sessions.lookup(input.sessionKey);
    const envelope = parseFunctionalFinnAnswerEnvelope(input.text);
    if (!binding || !envelope) {
      return undefined;
    }
    return {
      operation: input.operation,
      agentId: binding.agentId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      accountId: input.accountId,
      target: input.target,
      revision: input.revision,
      envelope,
      evidence: params.evidence.listRun(input.runId),
    };
  };

  return {
    bindSession(input: { sessionKey?: string; agentId?: string; channel?: string }): void {
      if (
        input.sessionKey &&
        input.agentId &&
        input.channel &&
        params.config.agentIds.includes(input.agentId) &&
        params.config.channels.includes(input.channel)
      ) {
        params.sessions.register(
          input.sessionKey,
          { agentId: input.agentId, channel: input.channel },
          { ttlMs: 30 * 24 * 60 * 60 * 1_000 },
        );
      }
    },

    async beforeFinalize(input: {
      text?: string;
      sessionKey?: string;
      runId?: string;
      channel?: string;
    }): Promise<
      | undefined
      | {
          action: "revise";
          reason: string;
          retry: { instruction: string; idempotencyKey: string; maxAttempts: 1 };
        }
    > {
      if (!isProtected(input.sessionKey, input.channel)) {
        return undefined;
      }
      if (!input.sessionKey || !input.runId || !input.text) {
        return undefined;
      }
      const key = `${input.sessionKey}:${input.runId}`;
      const request = verifierRequest({
        operation: "validate",
        text: input.text,
        sessionKey: input.sessionKey,
        runId: input.runId,
      });
      let valid = false;
      if (request) {
        try {
          valid = (await params.verify(request)).ok;
        } catch {
          valid = false;
        }
      }
      if (valid || params.revisions.lookup(key)) {
        return undefined;
      }
      params.revisions.register(key, { requested: true }, { ttlMs: 24 * 60 * 60 * 1_000 });
      return {
        action: "revise",
        reason: "Functional Finn evidence verification failed",
        retry: {
          instruction:
            "Revise once. Return the required JSON envelope. Remove unsupported claims; if support remains insufficient, return a factual abstention with claims=[].",
          idempotencyKey: `functional-finn:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
          maxAttempts: 1,
        },
      };
    },

    async prepareReply(input: {
      text?: string;
      sessionKey?: string;
      runId?: string;
      channel?: string;
      accountId?: string;
      target?: string;
    }): Promise<
      | { cancel: true; reason: string }
      | {
          text: string;
          authorization: Record<string, unknown>;
          verifier: { socketPath: string; timeoutMs: number };
        }
      | undefined
    > {
      if (!isProtected(input.sessionKey, input.channel)) {
        return undefined;
      }
      if (!input.sessionKey || !input.runId || !input.text || !input.accountId || !input.target) {
        return { cancel: true, reason: "Functional Finn release identity is incomplete" };
      }
      const request = verifierRequest({
        operation: "authorize",
        text: input.text,
        sessionKey: input.sessionKey,
        runId: input.runId,
        accountId: input.accountId,
        target: input.target,
        revision: params.revisions.lookup(`${input.sessionKey}:${input.runId}`) ? 1 : 0,
      });
      if (!request) {
        return { cancel: true, reason: "Functional Finn answer envelope is invalid" };
      }
      try {
        const result = await params.verify(request);
        if (!result.ok || !result.authorization) {
          return { cancel: true, reason: "Functional Finn answer is unsupported" };
        }
        return {
          text: request.envelope.answerText,
          authorization: result.authorization,
          verifier: {
            socketPath: params.config.verifierSocketPath,
            timeoutMs: params.config.verifierTimeoutMs,
          },
        };
      } catch {
        return { cancel: true, reason: "Functional Finn verifier is unavailable" };
      }
    },
  };
}
