import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  digestFunctionalFinnPayload,
  digestFunctionalFinnTarget,
  parseFunctionalFinnReleaseReceipt,
  verifyFunctionalFinnReleaseReceipt,
  type FunctionalFinnReleaseAuthorization,
  type FunctionalFinnReleaseReceipt,
} from "./functional-finn-release-receipt.js";
import {
  lookupFunctionalFinnSignalRelease,
  reserveFunctionalFinnSignalRelease,
} from "./functional-finn-release-store.js";
import {
  digestFunctionalFinnSignalFrame,
  type FunctionalFinnSignalFrame,
} from "./functional-finn-signal-frame.js";

type FunctionalFinnVerifierEndpoint = { socketPath: string; timeoutMs: number };

export type FunctionalFinnVerifiedDelivery = {
  kind: "verified_candidate";
  candidateText: string;
  authorization?: FunctionalFinnReleaseAuthorization;
  verifier?: FunctionalFinnVerifierEndpoint;
  receipt?: FunctionalFinnReleaseReceipt;
};

export type SignalHostControlDelivery = { readonly kind: "host_control" };
const HOST_CONTROLS = new WeakSet<object>();

export function createSignalHostControlDelivery(): SignalHostControlDelivery {
  const value = Object.freeze({ kind: "host_control" as const });
  HOST_CONTROLS.add(value);
  return value;
}

function nonempty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseAuthorization(value: unknown): FunctionalFinnReleaseAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const fields = [
    "authorizationId",
    "keyId",
    "nonce",
    "agentId",
    "sessionKeyDigest",
    "runId",
    "accountId",
    "targetDigest",
    "payloadDigest",
    "evidenceDigest",
    "signature",
  ] as const;
  if (
    record.schemaVersion !== 1 ||
    record.channel !== "signal" ||
    (record.revision !== 0 && record.revision !== 1) ||
    !Number.isSafeInteger(record.issuedAt) ||
    !Number.isSafeInteger(record.expiresAt) ||
    fields.some((field) => !nonempty(record, field))
  ) {
    return undefined;
  }
  return record as FunctionalFinnReleaseAuthorization;
}

export function readFunctionalFinnVerifiedDelivery(
  channelData: Record<string, unknown> | undefined,
): FunctionalFinnVerifiedDelivery | undefined {
  const raw = channelData?.functionalFinnRelease;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "verified_candidate" || typeof record.candidateText !== "string") {
    return undefined;
  }
  const receipt = parseFunctionalFinnReleaseReceipt(record.receipt);
  const authorization = parseAuthorization(record.authorization);
  const verifierRecord = record.verifier;
  const verifier =
    verifierRecord && typeof verifierRecord === "object" && !Array.isArray(verifierRecord)
      ? (verifierRecord as Record<string, unknown>)
      : undefined;
  if (
    !receipt &&
    (!authorization ||
      typeof verifier?.socketPath !== "string" ||
      !verifier.socketPath ||
      !Number.isSafeInteger(verifier.timeoutMs) ||
      (verifier.timeoutMs as number) <= 0)
  ) {
    return undefined;
  }
  return {
    kind: "verified_candidate",
    candidateText: record.candidateText,
    ...(receipt ? { receipt } : {}),
    ...(authorization ? { authorization } : {}),
    ...(verifier
      ? {
          verifier: {
            socketPath: verifier.socketPath as string,
            timeoutMs: verifier.timeoutMs as number,
          },
        }
      : {}),
  };
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

async function bindFunctionalFinnFrame(params: {
  endpoint: FunctionalFinnVerifierEndpoint;
  authorization: FunctionalFinnReleaseAuthorization;
  candidateText: string;
  frame: FunctionalFinnSignalFrame;
}): Promise<FunctionalFinnReleaseReceipt> {
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    operation: "bind_frame",
    authorization: params.authorization,
    candidateText: params.candidateText,
    frame: params.frame,
  })}\n`;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(params.endpoint.socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(params.endpoint.timeoutMs, () =>
      fail(new Error("Functional Finn frame verifier timed out")),
    );
    socket.once("error", (error) => fail(error));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        fail(new Error("Functional Finn frame verifier response is oversized"));
      } else {
        chunks.push(chunk);
      }
    });
    socket.once("end", () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const receipt =
          response?.ok === true ? parseFunctionalFinnReleaseReceipt(response.receipt) : undefined;
        if (!receipt) {
          throw new Error("Functional Finn frame verifier denied release");
        }
        resolve(receipt);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => socket.end(payload));
  });
}

export function preflightFunctionalFinnSignalSend(params: {
  cfg: OpenClawConfig;
  accountId: string;
  sourceText: string;
  hasMedia: boolean;
  delivery?: FunctionalFinnVerifiedDelivery | SignalHostControlDelivery;
}): "off" | "host_control" | "verified_candidate" {
  if (readReleaseConfig(params.cfg, params.accountId)?.enabled !== true) {
    return "off";
  }
  if (params.delivery && HOST_CONTROLS.has(params.delivery)) {
    return "host_control";
  }
  if (
    params.hasMedia ||
    params.delivery?.kind !== "verified_candidate" ||
    params.delivery.candidateText !== params.sourceText ||
    params.sourceText.length > 3_500
  ) {
    throw new Error("Functional Finn blocked unverified Signal delivery");
  }
  return "verified_candidate";
}

export async function authorizeFunctionalFinnSignalSend(params: {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  sourceText: string;
  frame: FunctionalFinnSignalFrame;
  delivery?: FunctionalFinnVerifiedDelivery | SignalHostControlDelivery;
  now?: number;
}): Promise<
  | { protected: false }
  | { protected: true; hostControl: true }
  | {
      protected: true;
      logicalId: string;
      replayed?: { messageId: string; timestamp?: number };
      quoteRejected?: true;
    }
> {
  const config = readReleaseConfig(params.cfg, params.accountId);
  if (config?.enabled !== true) {
    return { protected: false };
  }
  if (params.delivery && HOST_CONTROLS.has(params.delivery)) {
    return { protected: true, hostControl: true };
  }
  if (
    params.delivery?.kind !== "verified_candidate" ||
    params.delivery.candidateText !== params.sourceText
  ) {
    throw new Error("Functional Finn blocked unverified Signal delivery");
  }
  const authorization = params.delivery.authorization;
  const suppliedReceipt = params.delivery.receipt;
  const identity = suppliedReceipt ?? authorization;
  const publicKeyFile = config.publicKeyFile?.trim();
  const keyId = config.keyId?.trim();
  if (!identity || !publicKeyFile || !keyId) {
    throw new Error("Functional Finn Signal release configuration is incomplete");
  }
  const targetDigest = digestFunctionalFinnTarget(params.to);
  const frameDigest = digestFunctionalFinnSignalFrame(params.frame);
  const payloadDigest = digestFunctionalFinnPayload(params.sourceText);
  if (
    params.frame.accountId !== params.accountId ||
    identity.accountId !== params.accountId ||
    identity.targetDigest !== targetDigest ||
    identity.payloadDigest !== payloadDigest
  ) {
    throw new Error("Functional Finn blocked altered Signal frame identity");
  }
  const logicalId = digestFunctionalFinnPayload(
    JSON.stringify([
      identity.sessionKeyDigest,
      identity.runId,
      params.accountId,
      targetDigest,
      frameDigest,
      identity.revision,
    ]),
  );
  const lookup = lookupFunctionalFinnSignalRelease({
    logicalId,
    accountId: params.accountId,
    targetDigest,
    frameDigest,
    revision: identity.revision,
  });
  if (lookup?.state === "sent") {
    return { protected: true, logicalId, replayed: lookup.replayed };
  }
  if (lookup?.state === "quote_rejected") {
    return { protected: true, logicalId, quoteRejected: true };
  }
  if (lookup?.state === "pending") {
    throw new Error("Functional Finn release delivery outcome is unknown");
  }
  const receipt =
    suppliedReceipt ??
    (authorization && params.delivery.verifier
      ? await bindFunctionalFinnFrame({
          endpoint: params.delivery.verifier,
          authorization,
          candidateText: params.sourceText,
          frame: params.frame,
        })
      : undefined);
  if (!receipt) {
    throw new Error("Functional Finn frame receipt is unavailable");
  }
  const publicKeyPem = await fs.readFile(assertAbsoluteKeyPath(publicKeyFile), "utf8");
  if (
    !verifyFunctionalFinnReleaseReceipt({
      receipt,
      publicKeyPem,
      expectedKeyId: keyId,
      expected: { accountId: params.accountId, targetDigest, payloadDigest, frameDigest },
      now: params.now ?? Date.now(),
      maxLifetimeMs: config.maxLifetimeMs ?? 60_000,
    })
  ) {
    throw new Error("Functional Finn blocked invalid Signal release receipt");
  }
  const reservation = reserveFunctionalFinnSignalRelease({
    logicalId,
    accountId: params.accountId,
    targetDigest,
    frameDigest,
    revision: receipt.revision,
    receipt,
  });
  if (!reservation.created) {
    if (reservation.existing.state === "sent") {
      return { protected: true, logicalId, replayed: reservation.existing.replayed };
    }
    if (reservation.existing.state === "quote_rejected") {
      return { protected: true, logicalId, quoteRejected: true };
    }
    throw new Error("Functional Finn release delivery outcome is unknown");
  }
  return { protected: true, logicalId };
}
