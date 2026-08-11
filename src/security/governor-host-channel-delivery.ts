import type { ChannelOutboundAdapter } from "../channels/plugins/outbound.types.js";
/** Compiled Signal/iMessage delivery implementations owned by trusted host bootstrap. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../infra/outbound/channel-resolution.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorIdentityContext } from "../tasks/governor/types.js";

export type GovernorHostDeliveryRuntime = Readonly<{
  cfg: OpenClawConfig;
  stateDir: string;
  deploymentIdentity: string;
  identity: GovernorIdentityContext;
}>;

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  Object.freeze(value);
}

export function createGovernorHostDeliveryRuntime(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  deploymentIdentity: string;
  identity: GovernorIdentityContext;
}): GovernorHostDeliveryRuntime {
  const stateDir = params.stateDir.trim();
  if (!stateDir) {
    throw new Error("Governor host delivery state directory is required");
  }
  const cfg = structuredClone(params.cfg);
  deepFreeze(cfg);
  return Object.freeze({
    cfg,
    stateDir,
    deploymentIdentity: params.deploymentIdentity,
    identity: params.identity,
  });
}

export type HostPrimitiveDeliveryResult =
  | Readonly<{ status: "sent"; providerReceipt: GovernorJsonValue }>
  | Readonly<{ status: "unknown"; reasonDigest: string; reconcileSupported: boolean }>
  | Readonly<{ status: "not_sent"; reasonDigest: string }>;

export type HostPrimitiveReconciliationResult =
  | Readonly<{ status: "sent"; providerReceipt: GovernorJsonValue }>
  | Readonly<{ status: "not_sent" | "unresolved" }>;

export type HostCompiledSender = Readonly<{
  channel: "canary" | "imessage" | "signal";
  accountId: string;
  normalizedTarget: string;
  mode: "active" | "shadow";
  send: (params: {
    deliveryKey: string;
    payload: GovernorJsonValue;
  }) => Promise<HostPrimitiveDeliveryResult>;
  reconcile: (params: {
    deliveryKey: string;
    payloadDigest: string;
  }) => Promise<HostPrimitiveReconciliationResult>;
}>;

type ChannelConfig = Readonly<{
  accountId: string;
  target: string;
  mode: "active" | "shadow";
}>;

function parseChannelConfig(value: GovernorJsonValue): ChannelConfig {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Governor channel delivery config must be an object");
  }
  const keys = Object.keys(value).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(["accountId", "mode", "target"])) {
    throw new Error("Governor channel delivery config contains unknown fields");
  }
  const accountId = value.accountId;
  const target = value.target;
  const mode = value.mode;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("Governor channel delivery accountId is required");
  }
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Governor channel delivery target is required");
  }
  if (mode !== "active" && mode !== "shadow") {
    throw new Error("Governor channel delivery mode must be active or shadow");
  }
  return Object.freeze({ accountId: accountId.trim(), target: target.trim(), mode });
}

function parseTextPayload(payload: GovernorJsonValue): string {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("Governor channel delivery payload must be an object");
  }
  const expectedKeys = ["certificateDigest", "kind", "text"];
  if (JSON.stringify(Object.keys(payload).toSorted()) !== JSON.stringify(expectedKeys)) {
    throw new Error("Governor channel delivery payload contains unsupported fields");
  }
  if (
    payload.kind !== "completion" ||
    typeof payload.certificateDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.certificateDigest) ||
    typeof payload.text !== "string" ||
    !payload.text.trim()
  ) {
    throw new Error("Governor channel delivery text is required");
  }
  return payload.text;
}

function unknown(reason: string): HostPrimitiveDeliveryResult {
  return {
    status: "unknown",
    reasonDigest: governorDigest({ reason }),
    reconcileSupported: false,
  };
}

type CompiledChannel = "imessage" | "signal";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

type BoundChannelSendText = NonNullable<ChannelOutboundAdapter["sendText"]>;

function resolveCompiledChannelBinding(params: {
  channel: CompiledChannel;
  config: ChannelConfig;
  runtime: GovernorHostDeliveryRuntime;
}): { normalizedTarget: string; sendText: BoundChannelSendText } {
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.runtime.cfg,
    allowBootstrap: true,
  });
  if (!plugin) {
    throw new Error(`Governor ${params.channel} compiled channel is unavailable`);
  }
  const sendText = plugin.outbound?.sendText;
  if (plugin.outbound?.deliveryMode !== "direct" || typeof sendText !== "function") {
    throw new Error(`Governor ${params.channel} compiled direct sender is unavailable`);
  }
  if (!plugin.config.listAccountIds(params.runtime.cfg).includes(params.config.accountId)) {
    throw new Error(`Governor ${params.channel} account is unavailable or mismatched`);
  }
  const account = plugin.config.resolveAccount(params.runtime.cfg, params.config.accountId);
  if (plugin.config.isEnabled?.(account, params.runtime.cfg) === false) {
    throw new Error(`Governor ${params.channel} account is disabled`);
  }
  const configured = plugin.config.isConfigured?.(account, params.runtime.cfg);
  if (isPromiseLike(configured)) {
    throw new Error(`Governor ${params.channel} account cannot be verified synchronously`);
  }
  if (configured === false) {
    throw new Error(`Governor ${params.channel} account is not configured`);
  }
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.config.target,
    cfg: params.runtime.cfg,
    accountId: params.config.accountId,
    allowBootstrap: true,
    mode: "explicit",
  });
  if (!resolved.ok) {
    throw new Error(`Governor ${params.channel} target is invalid`);
  }
  return { normalizedTarget: resolved.to, sendText };
}

function createCompiledChannelSender(params: {
  channel: CompiledChannel;
  configValue: GovernorJsonValue;
  runtime: GovernorHostDeliveryRuntime;
}): HostCompiledSender {
  const config = parseChannelConfig(params.configValue);
  const { normalizedTarget, sendText } = resolveCompiledChannelBinding({
    channel: params.channel,
    config,
    runtime: params.runtime,
  });
  return Object.freeze({
    channel: params.channel,
    accountId: config.accountId,
    normalizedTarget,
    mode: config.mode,
    send: async ({ deliveryKey, payload }) => {
      try {
        // Capture the exact plugin function at trusted bootstrap. This call
        // never re-resolves the mutable runtime plugin registry.
        const receipt = await sendText({
          cfg: params.runtime.cfg,
          accountId: config.accountId,
          to: normalizedTarget,
          text: parseTextPayload(payload),
          deliveryQueueId: deliveryKey,
        });
        const messageId = receipt.messageId;
        if (!messageId || messageId === "unknown" || messageId === "ok") {
          return unknown(`${params.channel}_receipt_missing_stable_id`);
        }
        return {
          status: "sent" as const,
          providerReceipt: {
            channel: receipt.channel,
            messageId,
            ...("timestamp" in receipt && typeof receipt.timestamp === "number"
              ? { timestamp: receipt.timestamp }
              : {}),
          },
        };
      } catch {
        return unknown(`${params.channel}_send_outcome_unknown`);
      }
    },
    reconcile: async () => ({ status: "unresolved" as const }),
  });
}

export function createSignalHostSender(
  configValue: GovernorJsonValue,
  runtime: GovernorHostDeliveryRuntime,
): HostCompiledSender {
  return createCompiledChannelSender({ channel: "signal", configValue, runtime });
}

export function createIMessageHostSender(
  configValue: GovernorJsonValue,
  runtime: GovernorHostDeliveryRuntime,
): HostCompiledSender {
  return createCompiledChannelSender({ channel: "imessage", configValue, runtime });
}
