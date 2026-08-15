import { createHash } from "node:crypto";
import { parseFunctionalFinnAnswerEnvelope } from "./answer-envelope.js";
import {
  digestFunctionalFinnCandidate,
  validateFunctionalFinnCandidate,
  type ExternalCandidate,
} from "./release-authority-client.js";

type RejectNewStore<T> = {
  lookup: (key: string) => T | undefined;
  registerIfAbsent: (key: string, value: T) => boolean;
};

export type TrustedFunctionalFinnIngress = {
  schema: 1;
  ingressId: string;
  bindingId: string;
  accountId: string;
  sourceId: string;
  contentDigest: string;
  content: string;
  receivedAt: number;
  sequence: number;
  candidateSocketPath: string;
  timeoutMs: number;
};

export type FunctionalFinnExternalEscrow = {
  kind: "external_release_escrow";
  candidate: ExternalCandidate;
  candidateDigest: string;
};

export type FunctionalFinnExternalCandidateRecord = {
  candidate: ExternalCandidate;
  candidateDigest: string;
  candidateSocketPath: string;
  timeoutMs: number;
  validationState: "validated" | "unreleased";
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readTrustedFunctionalFinnIngress(
  channelContext: unknown,
): TrustedFunctionalFinnIngress | undefined {
  if (!channelContext || typeof channelContext !== "object") {
    return undefined;
  }
  const sender = (channelContext as { sender?: unknown }).sender;
  if (!sender || typeof sender !== "object") {
    return undefined;
  }
  const value = (sender as { functionalFinnIngress?: unknown }).functionalFinnIngress;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  const candidateSocketPath = readString(item.candidateSocketPath);
  const timeoutMs = item.timeoutMs;
  const required = [
    readString(item.ingressId),
    readString(item.bindingId),
    readString(item.accountId),
    readString(item.sourceId),
    readString(item.contentDigest),
    readString(item.content),
  ];
  if (
    item.schema !== 1 ||
    required.some((entry) => !entry) ||
    !candidateSocketPath ||
    !Number.isSafeInteger(item.receivedAt) ||
    !Number.isSafeInteger(item.sequence) ||
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 100 ||
    (timeoutMs as number) > 5_000
  ) {
    return undefined;
  }
  return {
    schema: 1,
    ingressId: required[0] as string,
    bindingId: required[1] as string,
    accountId: required[2] as string,
    sourceId: required[3] as string,
    contentDigest: required[4] as string,
    content: required[5] as string,
    receivedAt: item.receivedAt as number,
    sequence: item.sequence as number,
    candidateSocketPath,
    timeoutMs: timeoutMs as number,
  };
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

function utf8Offset(content: string, offset: number): number {
  return Buffer.byteLength(content.slice(0, offset), "utf8");
}

function buildCandidate(params: {
  text: string;
  sessionKey: string;
  runId: string;
  revision: 0 | 1;
  ingress: TrustedFunctionalFinnIngress;
}): ExternalCandidate | undefined {
  const envelope = parseFunctionalFinnAnswerEnvelope(params.text);
  if (!envelope) {
    return undefined;
  }
  const claims = envelope.claims.map((claim) => {
    const evidence = claim.sources.map((source) => {
      if (
        source.evidenceId !== params.ingress.ingressId ||
        params.ingress.content.slice(source.start, source.end) !== source.quote
      ) {
        return undefined;
      }
      return {
        kind: "signal_ingress" as const,
        ingressId: params.ingress.ingressId,
        startByte: utf8Offset(params.ingress.content, source.start),
        endByte: utf8Offset(params.ingress.content, source.end),
        quote: source.quote,
        receiptId: null,
      };
    });
    return evidence.some((item) => !item)
      ? undefined
      : {
          claimId: claim.claimId,
          text: claim.text,
          evidence: evidence as NonNullable<(typeof evidence)[number]>[],
        };
  });
  if (claims.some((claim) => !claim)) {
    return undefined;
  }
  const turnTicket = stableId(
    "turn",
    `${params.sessionKey}\0${params.runId}\0${params.ingress.ingressId}`,
  );
  const base = {
    turnTicket,
    revision: params.revision,
    ingressId: params.ingress.ingressId,
    bindingId: params.ingress.bindingId,
    responseClass: envelope.responseClass,
    message: envelope.answerText,
    claims: claims as NonNullable<(typeof claims)[number]>[],
  };
  const candidateId = stableId("candidate", JSON.stringify(base));
  return { candidateId, ...base };
}

export function createFunctionalFinnExternalReleasePolicy(params: {
  candidates: RejectNewStore<FunctionalFinnExternalCandidateRecord>;
  revisions: RejectNewStore<{ requested: true }>;
}) {
  const ingressByRun = new Map<string, TrustedFunctionalFinnIngress>();
  const keyFor = (sessionKey: string, runId: string) => `${sessionKey}:${runId}`;

  return {
    bindRun(runId: string | undefined, channelContext: unknown): void {
      const ingress = readTrustedFunctionalFinnIngress(channelContext);
      if (runId && ingress) {
        ingressByRun.set(runId, ingress);
      }
    },
    evidenceForRun(runId: string): TrustedFunctionalFinnIngress | undefined {
      return ingressByRun.get(runId);
    },
    clearRun(runId: string | undefined): void {
      if (runId) {
        ingressByRun.delete(runId);
      }
    },
    async beforeFinalize(input: {
      text?: string;
      sessionKey?: string;
      runId?: string;
      channelContext?: unknown;
    }) {
      if (!input.sessionKey || !input.runId) {
        return undefined;
      }
      const key = keyFor(input.sessionKey, input.runId);
      const prior = params.candidates.lookup(key);
      if (prior?.validationState === "unreleased") {
        return {
          action: "continue" as const,
          reason: "Functional Finn external escrow is denied",
        };
      }
      const ingress =
        readTrustedFunctionalFinnIngress(input.channelContext) ?? ingressByRun.get(input.runId);
      if (!ingress && !prior) {
        return undefined;
      }
      if (!input.text || !ingress) {
        return {
          action: "continue" as const,
          reason: "Functional Finn external escrow is unavailable",
        };
      }
      const revision: 0 | 1 = params.revisions.lookup(key) ? 1 : 0;
      const candidate = buildCandidate({
        text: input.text,
        sessionKey: input.sessionKey,
        runId: input.runId,
        ingress,
        revision,
      });
      if (!candidate) {
        if (revision === 0 && params.revisions.registerIfAbsent(key, { requested: true })) {
          return revisionResult(key);
        }
        return { action: "continue" as const, reason: "Functional Finn final envelope is invalid" };
      }
      const record: FunctionalFinnExternalCandidateRecord = {
        candidate,
        candidateDigest: digestFunctionalFinnCandidate(candidate),
        candidateSocketPath: ingress.candidateSocketPath,
        timeoutMs: ingress.timeoutMs,
        validationState: "unreleased",
      };
      try {
        const result = await validateFunctionalFinnCandidate({
          socketPath: record.candidateSocketPath,
          timeoutMs: record.timeoutMs,
          requestId: stableId("validate", candidate.candidateId),
          candidate,
        });
        if (result.status === "validated") {
          record.validationState = "validated";
          if (!params.candidates.registerIfAbsent(key, record)) {
            const existing = params.candidates.lookup(key);
            if (!existing || existing.candidateDigest !== record.candidateDigest) {
              return {
                action: "continue" as const,
                reason: "Functional Finn escrow replay conflict",
              };
            }
          }
          return { action: "continue" as const };
        }
        if (result.status === "revision_required" && revision === 0) {
          if (
            !params.revisions.registerIfAbsent(key, { requested: true }) &&
            !params.revisions.lookup(key)
          ) {
            return {
              action: "continue" as const,
              reason: "Functional Finn revision authority is unavailable",
            };
          }
          return revisionResult(key);
        }
        params.candidates.registerIfAbsent(key, record);
        return { action: "continue" as const, reason: `Functional Finn ${result.status}` };
      } catch {
        if (revision === 0 && params.revisions.registerIfAbsent(key, { requested: true })) {
          return revisionResult(key);
        }
        params.candidates.registerIfAbsent(key, record);
        return { action: "continue" as const, reason: "Functional Finn authority unavailable" };
      }
    },
    prepareReply(input: {
      text?: string;
      sessionKey?: string;
      runId?: string;
    }): { escrow: FunctionalFinnExternalEscrow } | { blocked: true } | undefined {
      if (!input.sessionKey || !input.runId) {
        return undefined;
      }
      const key = keyFor(input.sessionKey, input.runId);
      const record = params.candidates.lookup(key);
      if (!record) {
        return params.revisions.lookup(key) ? { blocked: true } : undefined;
      }
      if (!input.text || record.validationState !== "validated") {
        return { blocked: true };
      }
      const envelope = parseFunctionalFinnAnswerEnvelope(input.text);
      if (!envelope || envelope.answerText !== record.candidate.message) {
        return { blocked: true };
      }
      if (digestFunctionalFinnCandidate(record.candidate) !== record.candidateDigest) {
        return { blocked: true };
      }
      return {
        escrow: {
          kind: "external_release_escrow",
          candidate: record.candidate,
          candidateDigest: record.candidateDigest,
        },
      };
    },
  };
}

function revisionResult(key: string) {
  return {
    action: "revise" as const,
    reason: "Functional Finn evidence validation requires one revision",
    retry: {
      instruction:
        "Revise once. Remove unsupported claims or return the required factual abstention envelope.",
      idempotencyKey: stableId("functional-finn", key),
      maxAttempts: 1 as const,
    },
  };
}
