import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getSignalRuntime } from "./runtime.js";

type Cursor = { authorityId: string; ordinal: number };

let store: PluginStateSyncKeyedStore<Cursor> | undefined;

function cursorStore() {
  if (!store) {
    store = getSignalRuntime().state.openSyncKeyedStore<Cursor>({
      namespace: "functional-finn-signal-ingress-cursor-v1",
      maxEntries: 128,
      overflowPolicy: "reject-new",
    });
  }
  return store;
}

export function readFunctionalFinnIngressCursor(accountId: string): Cursor | undefined {
  return cursorStore().lookup(accountId) as Cursor | undefined;
}

export function advanceFunctionalFinnIngressCursor(params: {
  accountId: string;
  authorityId: string;
  ordinal: number;
}): void {
  const state = cursorStore();
  const existing = state.lookup(params.accountId) as Cursor | undefined;
  if (!existing) {
    if (
      !state.registerIfAbsent(params.accountId, {
        authorityId: params.authorityId,
        ordinal: params.ordinal,
      })
    ) {
      throw new Error("Functional Finn ingress cursor capacity is exhausted");
    }
    return;
  }
  if (existing.authorityId !== params.authorityId || params.ordinal <= existing.ordinal) {
    throw new Error("Functional Finn ingress cursor binding or sequence is invalid");
  }
  const updated = state.update?.(params.accountId, (current: Cursor | undefined) => {
    if (
      !current ||
      current.authorityId !== params.authorityId ||
      current.ordinal !== existing.ordinal
    ) {
      throw new Error("Functional Finn ingress cursor CAS lost");
    }
    return { authorityId: params.authorityId, ordinal: params.ordinal };
  });
  if (updated !== true) {
    throw new Error("Functional Finn ingress cursor update is unavailable");
  }
}
