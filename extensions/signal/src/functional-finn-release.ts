import fs from "node:fs/promises";
import path from "node:path";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnTarget,
  parseFunctionalFinnReleaseReceipt,
  verifyFunctionalFinnReleaseReceipt,
  type FunctionalFinnReleaseReceipt,
} from "./functional-finn-release-receipt.js";
import { reserveFunctionalFinnSignalRelease } from "./functional-finn-release-store.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type FunctionalFinnVerifiedDelivery = {
  kind: "verified_candidate";
  receipt: FunctionalFinnReleaseReceipt;
  candidateText: string;
};

export type SignalHostControlDelivery = { readonly kind: "host_control" };
const HOST_CONTROLS = new WeakSet<object>();

export function createSignalHostControlDelivery(): SignalHostControlDelivery {
  const value = Object.freeze({ kind: "host_control" as const });
  HOST_CONTROLS.add(value);
  return value;
}

export function readFunctionalFinnVerifiedDelivery(
  channelData: Record<string, unknown> | undefined,
): FunctionalFinnVerifiedDelivery | undefined {
  const raw = channelData?.functionalFinnRelease;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const receipt = parseFunctionalFinnReleaseReceipt(record.receipt);
  if (
    record.kind !== "verified_candidate" ||
    typeof record.candidateText !== "string" ||
    !receipt
  ) {
    return undefined;
  }
  return { kind: "verified_candidate", candidateText: record.candidateText, receipt };
}

type ReleaseConfig = {
  enabled?: boolean;
  publicKeyFile?: string;
  keyId?: string;
  maxLifetimeMs?: number;
};

function readReleaseConfig(cfg: OpenClawConfig, accountId: string): ReleaseConfig | undefined {
  const signal = cfg.channels?.signal as
    | (ReleaseConfig & {
        functionalFinnRelease?: ReleaseConfig;
        accounts?: Record<string, { functionalFinnRelease?: ReleaseConfig } | undefined>;
      })
    | undefined;
  return signal?.accounts?.[accountId]?.functionalFinnRelease ?? signal?.functionalFinnRelease;
}

function assertAbsoluteKeyPath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("Functional Finn release public key path must be absolute");
  }
  return value;
}

export async function authorizeFunctionalFinnSignalSend(params: {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  text: string;
  hasMedia: boolean;
  delivery?: FunctionalFinnVerifiedDelivery | SignalHostControlDelivery;
  now?: number;
}): Promise<
  | { protected: false }
  | {
      protected: true;
      receiptId?: string;
      replayed?: { messageId: string; timestamp?: number };
    }
> {
  const config = readReleaseConfig(params.cfg, params.accountId);
  const targetDigest = digestFunctionalFinnTarget(params.to);
  if (config?.enabled !== true) {
    return { protected: false };
  }
  if (params.delivery && HOST_CONTROLS.has(params.delivery)) {
    return { protected: true };
  }
  if (params.hasMedia || params.delivery?.kind !== "verified_candidate") {
    throw new Error("Functional Finn blocked unverified Signal delivery");
  }
  if (params.delivery.candidateText !== params.text || params.text.length > 3_500) {
    throw new Error("Functional Finn blocked altered or oversized Signal delivery");
  }
  const receipt = parseFunctionalFinnReleaseReceipt(params.delivery.receipt);
  const publicKeyFile = config.publicKeyFile?.trim();
  const keyId = config.keyId?.trim();
  if (!receipt || !publicKeyFile || !keyId) {
    throw new Error("Functional Finn Signal release configuration is incomplete");
  }
  const publicKeyPem = await fs.readFile(assertAbsoluteKeyPath(publicKeyFile), "utf8");
  const payloadDigest = digestFunctionalFinnPayload(params.text);
  if (
    !verifyFunctionalFinnReleaseReceipt({
      receipt,
      publicKeyPem,
      expectedKeyId: keyId,
      expected: { accountId: params.accountId, targetDigest, payloadDigest },
      now: params.now ?? Date.now(),
      maxLifetimeMs: config.maxLifetimeMs ?? 60_000,
    })
  ) {
    throw new Error("Functional Finn blocked invalid Signal release receipt");
  }
  const reservation = reserveFunctionalFinnSignalRelease({
    receiptId: receipt.receiptId,
    accountId: params.accountId,
    targetDigest,
    payloadDigest,
  });
  return { protected: true, receiptId: receipt.receiptId, ...reservation };
}
