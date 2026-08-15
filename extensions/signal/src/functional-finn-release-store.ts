import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { FunctionalFinnReleaseReceipt } from "./functional-finn-release-receipt.js";

type ReleaseDeliveryRecord = {
  state: "pending" | "sent" | "quote_rejected";
  accountId: string;
  targetDigest: string;
  frameDigest: string;
  revision: 0 | 1;
  receipt: FunctionalFinnReleaseReceipt;
  messageId?: string;
  timestamp?: number;
};

let store: PluginStateSyncKeyedStore<ReleaseDeliveryRecord> | undefined;

export function configureFunctionalFinnSignalReleaseStore(runtime: PluginRuntime): void {
  store = runtime.state.openSyncKeyedStore<ReleaseDeliveryRecord>({
    namespace: "functional-finn-release-delivery-v2",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
}

function requireStore(): PluginStateSyncKeyedStore<ReleaseDeliveryRecord> {
  if (!store) {
    throw new Error("Functional Finn Signal release store is unavailable");
  }
  return store;
}

function assertBinding(
  existing: ReleaseDeliveryRecord,
  params: Pick<ReleaseDeliveryRecord, "accountId" | "targetDigest" | "frameDigest" | "revision">,
): void {
  if (
    existing.accountId !== params.accountId ||
    existing.targetDigest !== params.targetDigest ||
    existing.frameDigest !== params.frameDigest ||
    existing.revision !== params.revision
  ) {
    throw new Error("Functional Finn logical release binding conflict");
  }
}

export function lookupFunctionalFinnSignalRelease(params: {
  logicalId: string;
  accountId: string;
  targetDigest: string;
  frameDigest: string;
  revision: 0 | 1;
}):
  | undefined
  | { state: "pending" }
  | { state: "quote_rejected" }
  | { state: "sent"; replayed: { messageId: string; timestamp: number } } {
  const existing = requireStore().lookup(params.logicalId);
  if (!existing) {
    return undefined;
  }
  assertBinding(existing, params);
  if (existing.state === "sent") {
    if (
      !existing.messageId ||
      !Number.isSafeInteger(existing.timestamp) ||
      (existing.timestamp as number) <= 0
    ) {
      throw new Error("Functional Finn sent release is missing its durable message identity");
    }
    return {
      state: "sent",
      replayed: { messageId: existing.messageId, timestamp: existing.timestamp as number },
    };
  }
  return existing.state === "quote_rejected" ? { state: "quote_rejected" } : { state: "pending" };
}

export function reserveFunctionalFinnSignalRelease(params: {
  logicalId: string;
  accountId: string;
  targetDigest: string;
  frameDigest: string;
  revision: 0 | 1;
  receipt: FunctionalFinnReleaseReceipt;
}):
  | { created: true }
  | {
      created: false;
      existing: NonNullable<ReturnType<typeof lookupFunctionalFinnSignalRelease>>;
    } {
  const state = requireStore();
  if (
    !state.registerIfAbsent(params.logicalId, {
      state: "pending",
      accountId: params.accountId,
      targetDigest: params.targetDigest,
      frameDigest: params.frameDigest,
      revision: params.revision,
      receipt: params.receipt,
    })
  ) {
    const existing = lookupFunctionalFinnSignalRelease(params);
    if (!existing) {
      throw new Error("Functional Finn release delivery store capacity exhausted");
    }
    return { created: false, existing };
  }
  return { created: true };
}

function updateRelease(
  logicalId: string,
  mutate: (current: ReleaseDeliveryRecord) => ReleaseDeliveryRecord,
): void {
  const updated = requireStore().update?.(logicalId, (current) => {
    if (!current || current.state !== "pending") {
      throw new Error("Functional Finn release reservation is missing");
    }
    return mutate(current);
  });
  if (updated !== true) {
    throw new Error("Functional Finn release settlement did not commit");
  }
}

export function settleFunctionalFinnSignalRelease(params: {
  logicalId: string;
  messageId: string;
  timestamp: number;
}): void {
  updateRelease(params.logicalId, (current) => ({
    ...current,
    state: "sent",
    messageId: params.messageId,
    timestamp: params.timestamp,
  }));
}

export function rejectFunctionalFinnSignalQuote(logicalId: string): void {
  updateRelease(logicalId, (current) => ({ ...current, state: "quote_rejected" }));
}
