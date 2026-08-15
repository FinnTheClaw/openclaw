import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { settleFunctionalFinnSignalRelease } from "./functional-finn-release-store.js";
import { authorizeFunctionalFinnSignalSend } from "./functional-finn-release.js";
import type {
  FunctionalFinnVerifiedDelivery,
  SignalHostControlDelivery,
} from "./functional-finn-release.js";
import { buildFunctionalFinnSignalFrame } from "./functional-finn-signal-frame.js";

export async function sendFunctionalFinnAuthorizedFrame(params: {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  sourceText: string;
  rpcParams: Record<string, unknown>;
  delivery?: FunctionalFinnVerifiedDelivery | SignalHostControlDelivery;
  send: () => Promise<{ timestamp?: number } | undefined>;
}) {
  const release = await authorizeFunctionalFinnSignalSend({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
    sourceText: params.sourceText,
    frame: buildFunctionalFinnSignalFrame({
      accountId: params.accountId,
      rpcParams: params.rpcParams,
    }),
    delivery: params.delivery,
  });
  if (release.protected && "replayed" in release && release.replayed) {
    return { replayed: release.replayed } as const;
  }
  if (release.protected && "quoteRejected" in release && release.quoteRejected) {
    return { quoteRejected: true } as const;
  }
  let result: { timestamp?: number } | undefined;
  try {
    result = await params.send();
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error), {
      cause: error,
    }) as Error & { functionalFinnLogicalId?: string };
    if (release.protected && "logicalId" in release) {
      wrapped.functionalFinnLogicalId = release.logicalId;
    }
    throw wrapped;
  }
  if (release.protected && "logicalId" in release) {
    const timestamp = result?.timestamp;
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0) {
      throw new Error("Functional Finn Signal RPC returned no durable message identity");
    }
    settleFunctionalFinnSignalRelease({
      logicalId: release.logicalId,
      messageId: String(timestamp),
      timestamp: timestamp as number,
    });
  }
  return { result } as const;
}
