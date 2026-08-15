import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { resolveFunctionalFinnExternalAuthority } from "./functional-finn-external-config.js";
import { sendProtectedFunctionalFinnSignal } from "./functional-finn-external-send.js";
import {
  pullFunctionalFinnIngress,
  type FunctionalFinnIngressRecord,
} from "./functional-finn-ingress-client.js";
import {
  advanceFunctionalFinnIngressCursor,
  readFunctionalFinnIngressCursor,
} from "./functional-finn-ingress-cursor.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type { SignalReactionMessage, SignalReceivePayload } from "./monitor/event-handler.types.js";

export type MonitorProtectedSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  config: OpenClawConfig;
};

function requestId(accountId: string, ordinal: number): string {
  return `pull:${createHash("sha256").update(`${accountId}\0${ordinal}`).digest("hex")}`;
}

function waitForNextPull(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, 250);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function payloadFor(record: FunctionalFinnIngressRecord): SignalReceivePayload {
  return {
    envelope: {
      ...(record.sourceKind === "phone"
        ? { sourceNumber: record.sourceId }
        : { sourceUuid: record.sourceId }),
      timestamp: record.receivedAt,
      dataMessage: {
        timestamp: record.receivedAt,
        message: record.content,
        ...(record.conversationKind === "group"
          ? { groupInfo: { groupId: record.conversationId } }
          : {}),
      },
    },
  };
}

export async function monitorProtectedFunctionalFinnSignal(
  opts: MonitorProtectedSignalOpts,
): Promise<void> {
  const runtime = opts.runtime ?? createNonExitingRuntime();
  const account = resolveSignalAccount({ cfg: opts.config, accountId: opts.accountId });
  const authority = resolveFunctionalFinnExternalAuthority({
    cfg: opts.config,
    accountId: account.accountId,
  });
  if (!authority) {
    throw new Error("Functional Finn protected Signal authority is not configured");
  }
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      opts.config.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const cursorAuthorityId = createHash("sha256")
    .update(`${account.accountId}\0${authority.ingressSocketPath}`)
    .digest("hex");
  const handler = createSignalEventHandler({
    runtime,
    cfg: opts.config,
    baseUrl: "",
    account: account.config.account,
    accountUuid: account.config.accountUuid,
    accountId: account.accountId,
    blockStreaming: true,
    historyLimit,
    groupHistories,
    textLimit: resolveTextChunkLimit(opts.config, "signal", account.accountId),
    dmPolicy: account.config.dmPolicy ?? "pairing",
    allowFrom: normalizeStringEntries(account.config.allowFrom),
    groupAllowFrom: normalizeStringEntries(
      account.config.groupAllowFrom ?? account.config.allowFrom,
    ),
    groupPolicy: account.config.groupPolicy ?? "allowlist",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 0,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    transportFeedbackEnabled: false,
    fetchAttachment: async () => null,
    deliverReplies: async ({ replies, accountId }) => {
      for (const reply of replies) {
        if (reply.mediaUrl || !reply.text) {
          throw new Error("Protected Functional Finn Signal delivery is text-only");
        }
        await sendProtectedFunctionalFinnSignal({
          cfg: opts.config,
          accountId,
          text: reply.text,
          channelData: reply.channelData,
        });
      }
    },
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (_value): _value is SignalReactionMessage => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "",
  });
  while (!opts.abortSignal?.aborted) {
    const cursor = readFunctionalFinnIngressCursor(account.accountId);
    if (cursor && cursor.authorityId !== cursorAuthorityId) {
      throw new Error("Functional Finn ingress cursor authority changed");
    }
    const records = await pullFunctionalFinnIngress({
      socketPath: authority.ingressSocketPath,
      timeoutMs: authority.timeoutMs,
      requestId: requestId(account.accountId, cursor?.ordinal ?? 0),
      afterOrdinal: cursor?.ordinal ?? 0,
      limit: 20,
    });
    for (const record of records) {
      if (record.accountId !== account.accountId || record.ordinal <= (cursor?.ordinal ?? 0)) {
        throw new Error("Functional Finn ingress account or ordinal binding is invalid");
      }
      await handler({
        event: "receive",
        data: JSON.stringify(payloadFor(record)),
        trustedIngress: {
          schema: 1,
          agentId: authority.agentId,
          ingressId: record.ingressId,
          bindingId: record.bindingId,
          accountId: record.accountId,
          sourceId: record.sourceId,
          contentDigest: record.contentDigest,
          content: record.content,
          receivedAt: record.receivedAt,
          sequence: record.sequence,
          candidateSocketPath: authority.candidateSocketPath,
          timeoutMs: authority.timeoutMs,
        },
      });
      advanceFunctionalFinnIngressCursor({
        accountId: account.accountId,
        authorityId: cursorAuthorityId,
        ordinal: record.ordinal,
      });
    }
    if (records.length === 0) {
      await waitForNextPull(opts.abortSignal);
    }
  }
}
