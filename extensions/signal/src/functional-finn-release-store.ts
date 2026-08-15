import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PluginRuntime } from "./runtime-api.js";

type ReleaseDeliveryRecord = {
  state: "pending" | "sent";
  accountId: string;
  targetDigest: string;
  payloadDigest: string;
  messageId?: string;
  timestamp?: number;
};

let store: PluginStateSyncKeyedStore<ReleaseDeliveryRecord> | undefined;

export function configureFunctionalFinnSignalReleaseStore(runtime: PluginRuntime): void {
  store = runtime.state.openSyncKeyedStore<ReleaseDeliveryRecord>({
    namespace: "functional-finn-release-delivery",
    maxEntries: 10_000,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: 7 * 24 * 60 * 60 * 1_000,
  });
}

function requireStore(): PluginStateSyncKeyedStore<ReleaseDeliveryRecord> {
  if (!store) {
    throw new Error("Functional Finn Signal release store is unavailable");
  }
  return store;
}

export function reserveFunctionalFinnSignalRelease(params: {
  receiptId: string;
  accountId: string;
  targetDigest: string;
  payloadDigest: string;
}): { replayed?: { messageId: string; timestamp?: number } } {
  const state = requireStore();
  const existing = state.lookup(params.receiptId);
  if (existing) {
    if (
      existing.accountId !== params.accountId ||
      existing.targetDigest !== params.targetDigest ||
      existing.payloadDigest !== params.payloadDigest
    ) {
      throw new Error("Functional Finn release receipt binding conflict");
    }
    if (existing.state === "sent" && existing.messageId) {
      return { replayed: { messageId: existing.messageId, timestamp: existing.timestamp } };
    }
    throw new Error("Functional Finn release delivery outcome is unknown");
  }
  if (!state.registerIfAbsent(params.receiptId, { state: "pending", ...params })) {
    return reserveFunctionalFinnSignalRelease(params);
  }
  return {};
}

export function settleFunctionalFinnSignalRelease(params: {
  receiptId: string;
  messageId: string;
  timestamp?: number;
}): void {
  const state = requireStore();
  const updated = state.update?.(params.receiptId, (current) => {
    if (!current || current.state !== "pending") {
      throw new Error("Functional Finn release reservation is missing");
    }
    return { ...current, state: "sent", messageId: params.messageId, timestamp: params.timestamp };
  });
  if (updated !== true) {
    throw new Error("Functional Finn release settlement did not commit");
  }
}
