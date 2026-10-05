import type { ToolStreamHost } from "./tool-stream-contract.ts";

type ToolStreamState = Pick<
  ToolStreamHost,
  | "toolStreamById"
  | "toolStreamOrder"
  | "chatToolMessages"
  | "chatStreamSegments"
  | "activityEventSeqById"
  | "knownAgentRunIds"
  | "waitingApprovalStatuses"
> & { toolStreamSyncTimer?: number | null };

export function canResetToolStream(host: Partial<ToolStreamState>): host is ToolStreamState {
  return (
    host.toolStreamById instanceof Map &&
    Array.isArray(host.toolStreamOrder) &&
    Array.isArray(host.chatToolMessages) &&
    Array.isArray(host.chatStreamSegments)
  );
}

export function syncToolStreamMessages(host: ToolStreamState) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

export function cancelToolStreamSync(host: Pick<ToolStreamState, "toolStreamSyncTimer">) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
}

export function resetToolStream(host: ToolStreamState) {
  cancelToolStreamSync(host);
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  // Pending approvals may be rehydrated by replay after the transient reset.
  for (const waiting of host.waitingApprovalStatuses?.values() ?? []) {
    host.activityEventSeqById?.delete(
      `approval:${JSON.stringify([waiting.runId, waiting.approvalId])}`,
    );
  }
  // Approval resolutions outlive transient streams, just like their tombstones.
  for (const identity of host.activityEventSeqById?.keys() ?? []) {
    if (!identity.startsWith("approval:")) {
      host.activityEventSeqById?.delete(identity);
    }
  }
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
  host.knownAgentRunIds?.clear();
  host.waitingApprovalStatuses?.clear();
  // Resolution can beat the overlay queue update. Keep tombstones across transient stream resets
  // until snapshot reconciliation observes the approval leaving the queue.
}

export function resetToolStreamRun(host: ToolStreamState, runId: string) {
  cancelToolStreamSync(host);
  const removedIdentities = new Set<string>();
  for (const identity of host.toolStreamOrder) {
    const entry = host.toolStreamById.get(identity);
    if (entry?.runId !== runId) {
      continue;
    }
    removedIdentities.add(identity);
  }
  for (const identity of removedIdentities) {
    host.toolStreamById.delete(identity);
  }
  const activityPrefix = `tool:[${JSON.stringify(runId)},`;
  for (const sequenceIdentity of host.activityEventSeqById?.keys() ?? []) {
    if (
      sequenceIdentity.startsWith(activityPrefix) ||
      sequenceIdentity.startsWith(`item:${runId}:`)
    ) {
      host.activityEventSeqById?.delete(sequenceIdentity);
    }
  }
  host.toolStreamOrder = host.toolStreamOrder.filter(
    (identity) => !removedIdentities.has(identity),
  );
  syncToolStreamMessages(host);
  host.chatStreamSegments = host.chatStreamSegments.filter((segment) => segment.runId !== runId);
  host.knownAgentRunIds?.delete(runId);
  for (const [approvalId, waitingApproval] of host.waitingApprovalStatuses ?? []) {
    if (waitingApproval.runId === runId) {
      host.waitingApprovalStatuses?.delete(approvalId);
    }
  }
}
