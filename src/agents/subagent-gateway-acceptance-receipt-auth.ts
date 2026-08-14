import crypto from "node:crypto";
import { canonicalGovernorJson, governorDigest } from "../tasks/governor/canonical-json.js";
import {
  readGatewayAcceptanceReceiptSigner,
  readGatewayAcceptanceReceiptSigners,
} from "./subagent-gateway-acceptance-receipt-runtime.js";

export type GatewayAcceptanceReceiptEnvelope = Readonly<{
  schema: "openclaw.gateway.acceptance.v2";
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  targetAgentId: string;
  childSessionKey: string;
  requestDigest: string;
  preparationDigest: string;
  resolvedDigest: string;
  requestEnvelopeDigest: string;
  messageDigest: string;
  model?: string;
  provider?: string;
  route?: string;
  thinking?: string;
  timeoutMs?: number;
  cwd?: string;
  workspaceDir?: string;
  sandbox?: string;
  context?: string;
  toolsDigest: string;
  promptDigest: string;
  attachmentDigest: string;
  materializationDigest: string;
  completionDigest: string;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  gatewayRunId: string;
  acceptanceEpoch: string;
  signingKeyGeneration: string;
  receiptGeneration: number;
}>;

export type GatewayAcceptanceReceiptProof = Readonly<{
  keyId: string;
  nonce: string;
  signature: string;
  envelopeDigest: string;
}>;

type JsonRecord = Record<string, unknown>;

function jsonValue(value: unknown): JsonRecord | unknown[] | string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return typeof value === "bigint"
    ? value.toString(10)
    : typeof value === "symbol"
      ? (value.description ?? "")
      : "[unsupported]";
}

function digestUnknown(value: unknown): string {
  return governorDigest(jsonValue(value) as never);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Creates the redacted, canonical envelope. Raw messages and attachments are never stored. */
export function buildGatewayAcceptanceReceiptEnvelope(params: {
  acceptanceKey: string;
  intentId: string;
  controllerSessionKey: string;
  targetAgentId?: string;
  childSessionKey: string;
  requestDigest: string;
  preparationDigest?: string;
  resolvedDigest: string;
  request: unknown;
  gatewayRunId: string;
  acceptanceEpoch: string;
  receiptGeneration: number;
}): GatewayAcceptanceReceiptEnvelope {
  const request = (
    params.request && typeof params.request === "object" ? params.request : {}
  ) as JsonRecord;
  const normalizedRequest = jsonValue(request);
  const envelope: GatewayAcceptanceReceiptEnvelope = {
    schema: "openclaw.gateway.acceptance.v2",
    acceptanceKey: params.acceptanceKey,
    intentId: params.intentId,
    controllerSessionKey: params.controllerSessionKey,
    targetAgentId: optionalString(request.agentId) ?? params.targetAgentId ?? "unknown",
    childSessionKey: params.childSessionKey,
    requestDigest: params.requestDigest,
    preparationDigest: params.preparationDigest ?? params.requestDigest,
    resolvedDigest: params.resolvedDigest,
    requestEnvelopeDigest: digestUnknown(normalizedRequest),
    messageDigest: digestUnknown(request.message ?? ""),
    ...(optionalString(request.model) ? { model: optionalString(request.model) } : {}),
    ...(optionalString(request.provider) ? { provider: optionalString(request.provider) } : {}),
    ...(optionalString(request.model) || optionalString(request.provider)
      ? {
          route: `${optionalString(request.provider) ?? "default"}/${optionalString(request.model) ?? "default"}`,
        }
      : {}),
    ...(optionalString(request.thinking) ? { thinking: optionalString(request.thinking) } : {}),
    ...(typeof request.timeout === "number" ? { timeoutMs: request.timeout } : {}),
    ...(optionalString(request.cwd) ? { cwd: optionalString(request.cwd) } : {}),
    ...(optionalString(request.workspaceDir)
      ? { workspaceDir: optionalString(request.workspaceDir) }
      : {}),
    ...(optionalString(request.sandbox) ? { sandbox: optionalString(request.sandbox) } : {}),
    ...(optionalString(request.context) ? { context: optionalString(request.context) } : {}),
    toolsDigest: digestUnknown(request.toolsAllow ?? null),
    promptDigest: digestUnknown(request.extraSystemPrompt ?? null),
    attachmentDigest: digestUnknown(request.attachments ?? null),
    materializationDigest: digestUnknown({
      attachments: request.attachments,
      attachmentReceipt: request.attachmentReceipt,
      attachMountPath: request.attachMountPath,
    }),
    completionDigest: digestUnknown({
      deliver: request.deliver,
      sourceReplyDeliveryMode: request.sourceReplyDeliveryMode,
      expectsCompletionMessage: request.expectsCompletionMessage,
      completionGroup: request.completionGroup,
      finalChannel: request.channel,
      finalAccountId: request.accountId,
      finalTo: request.to,
      finalThreadId: request.threadId,
    }),
    ...(optionalString(request.channel) ? { channel: optionalString(request.channel) } : {}),
    ...(optionalString(request.accountId) ? { accountId: optionalString(request.accountId) } : {}),
    ...(optionalString(request.to) ? { to: optionalString(request.to) } : {}),
    ...(request.threadId !== undefined
      ? {
          threadId:
            typeof request.threadId === "string" || typeof request.threadId === "number"
              ? String(request.threadId)
              : (JSON.stringify(request.threadId) ?? ""),
        }
      : {}),
    gatewayRunId: params.gatewayRunId,
    acceptanceEpoch: params.acceptanceEpoch,
    signingKeyGeneration: readGatewayAcceptanceReceiptSigner()?.generation ?? "test",
    receiptGeneration: params.receiptGeneration,
  };
  return envelope;
}

export function canonicalGatewayAcceptanceReceiptEnvelope(
  envelope: GatewayAcceptanceReceiptEnvelope,
): string {
  return canonicalGovernorJson(jsonValue(envelope) as never);
}

export function gatewayAcceptanceReceiptEnvelopeDigest(
  envelope: GatewayAcceptanceReceiptEnvelope,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalGatewayAcceptanceReceiptEnvelope(envelope))
    .digest("hex");
}

/** Digest of behavior and delivery bindings, excluding per-attempt identity. */
export function gatewayAcceptanceReceiptBindingDigest(
  envelope: GatewayAcceptanceReceiptEnvelope,
): string {
  return gatewayAcceptanceReceiptEnvelopeDigest({
    ...envelope,
    gatewayRunId: "",
    acceptanceEpoch: "",
    signingKeyGeneration: "",
    receiptGeneration: 0,
  });
}

function resolveSigningKey(): string {
  const active = readGatewayAcceptanceReceiptSigner()?.signingKey;
  if (active) {
    return active;
  }
  if (process.env.NODE_ENV === "test") {
    return "openclaw-test-gateway-acceptance-receipt-key";
  }
  throw new Error("GOVERNOR_GATEWAY_RECEIPT_SIGNING_KEY_UNAVAILABLE");
}

export function gatewayAcceptanceReceiptKeyId(key = resolveSigningKey()): string {
  return crypto
    .createHash("sha256")
    .update(`openclaw-gateway-acceptance-receipt-key:v2:${key}`)
    .digest("hex");
}

function proofMessage(params: {
  envelopeDigest: string;
  keyId: string;
  nonce: string;
  signatureGeneration: number;
  lifecycle: string;
  cancelEpoch: number;
}): string {
  return canonicalGovernorJson({
    schema: "openclaw.gateway.acceptance.receipt-proof.v2",
    envelopeDigest: params.envelopeDigest,
    keyId: params.keyId,
    nonce: params.nonce,
    signatureGeneration: params.signatureGeneration,
    lifecycle: params.lifecycle,
    cancelEpoch: params.cancelEpoch,
  });
}

function signProof(params: {
  key: string;
  envelopeDigest: string;
  keyId: string;
  nonce: string;
  signatureGeneration: number;
  lifecycle: string;
  cancelEpoch: number;
}): string {
  return crypto.createHmac("sha256", params.key).update(proofMessage(params)).digest("hex");
}

export function createGatewayAcceptanceReceiptProof(params: {
  envelope: GatewayAcceptanceReceiptEnvelope;
  nonce?: string;
  key?: string;
  lifecycle: string;
  cancelEpoch: number;
}): GatewayAcceptanceReceiptProof {
  const key = params.key ?? resolveSigningKey();
  const keyId = gatewayAcceptanceReceiptKeyId(key);
  const nonce = params.nonce ?? crypto.randomBytes(16).toString("hex");
  const envelopeDigest = gatewayAcceptanceReceiptEnvelopeDigest(params.envelope);
  return {
    keyId,
    nonce,
    envelopeDigest,
    signature: signProof({
      key,
      envelopeDigest,
      keyId,
      nonce,
      signatureGeneration: params.envelope.receiptGeneration,
      lifecycle: params.lifecycle,
      cancelEpoch: params.cancelEpoch,
    }),
  };
}

export function verifyGatewayAcceptanceReceiptProof(params: {
  envelope: GatewayAcceptanceReceiptEnvelope;
  proof: GatewayAcceptanceReceiptProof;
  key?: string;
  lifecycle: string;
  cancelEpoch: number;
}): boolean {
  try {
    const envelopeDigest = gatewayAcceptanceReceiptEnvelopeDigest(params.envelope);
    const candidates = [
      ...(params.key ? [{ signingKey: params.key }] : readGatewayAcceptanceReceiptSigners()),
    ];
    if (candidates.length === 0 && process.env.NODE_ENV === "test") {
      candidates.push({ signingKey: "openclaw-test-gateway-acceptance-receipt-key" });
    }
    return candidates.some(({ signingKey }) => {
      const keyId = gatewayAcceptanceReceiptKeyId(signingKey);
      const expected = signProof({
        key: signingKey,
        envelopeDigest,
        keyId,
        nonce: params.proof.nonce,
        signatureGeneration: params.envelope.receiptGeneration,
        lifecycle: params.lifecycle,
        cancelEpoch: params.cancelEpoch,
      });
      return (
        params.proof.keyId === keyId &&
        params.proof.envelopeDigest === envelopeDigest &&
        params.proof.signature.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(params.proof.signature), Buffer.from(expected))
      );
    });
  } catch {
    return false;
  }
}
