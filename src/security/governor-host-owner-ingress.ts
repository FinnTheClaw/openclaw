/** Compiled, host-private owner ingress adapters for authenticated channel envelopes. */
import type {
  GovernorOwnerAction,
  HostGovernorCapabilities,
  HostGovernorOwnerIngressReceiptId,
} from "./governor-host-contracts.js";

type CommonOwnerEnvelope = Readonly<{
  accountId: string;
  gatewayInstanceId: string;
  ownerPrincipal: string;
  sourceSequence: number;
  action: GovernorOwnerAction;
  scopeKey: string;
  nonce: string;
  observedAt: number;
  expiresAt: number;
}>;

export type AuthenticatedSignalOwnerEnvelope = CommonOwnerEnvelope &
  Readonly<{ transportEventId: string }>;
export type AuthenticatedIMessageOwnerEnvelope = CommonOwnerEnvelope &
  Readonly<{ messageGuid: string; subscriptionInstanceId: string }>;

export type GovernorOwnerIngressBinding = Readonly<{
  channel: "imessage" | "signal";
  accountId: string;
  gatewayInstanceId: string;
  ownerPrincipal: string;
  actions: readonly GovernorOwnerAction[];
  scopeKeys: readonly string[];
}>;

function assertExactObject(value: object, expectedKeys: readonly string[], label: string): void {
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some(
      (key) => typeof key === "symbol" || !(key in descriptors) || !("value" in descriptors[key]),
    ) ||
    JSON.stringify(keys.map(String).toSorted()) !== JSON.stringify([...expectedKeys].toSorted())
  ) {
    throw new Error(`Governor ${label} owner envelope contains unknown or accessor fields`);
  }
}

export function createCompiledOwnerIngress(
  submit: HostGovernorCapabilities["submitAuthenticatedOwnerIngress"],
  configuredBindings: readonly GovernorOwnerIngressBinding[],
) {
  if (configuredBindings.length === 0) {
    throw new Error("Governor owner ingress requires an authenticated binding");
  }
  const bindings = configuredBindings.map((binding) => {
    assertExactObject(
      binding,
      ["channel", "accountId", "gatewayInstanceId", "ownerPrincipal", "actions", "scopeKeys"],
      "configured",
    );
    if (
      (binding.channel !== "signal" && binding.channel !== "imessage") ||
      !binding.accountId.trim() ||
      !binding.gatewayInstanceId.trim() ||
      !binding.ownerPrincipal.trim() ||
      binding.actions.length === 0 ||
      binding.actions.some(
        (action) => !["approve", "enable", "reinvestigate", "repair", "revoke"].includes(action),
      ) ||
      binding.scopeKeys.length === 0 ||
      binding.scopeKeys.some((scopeKey) => !scopeKey.trim())
    ) {
      throw new Error("Governor owner-ingress binding is incomplete");
    }
    return Object.freeze({
      ...binding,
      actions: Object.freeze([...binding.actions]),
      scopeKeys: Object.freeze([...binding.scopeKeys]),
    });
  });
  const requireBinding = (params: {
    channel: "imessage" | "signal";
    envelope: CommonOwnerEnvelope;
  }) => {
    const binding = bindings.find(
      (candidate) =>
        candidate.channel === params.channel &&
        candidate.accountId === params.envelope.accountId &&
        candidate.gatewayInstanceId === params.envelope.gatewayInstanceId &&
        candidate.ownerPrincipal === params.envelope.ownerPrincipal &&
        candidate.actions.includes(params.envelope.action) &&
        candidate.scopeKeys.includes(params.envelope.scopeKey),
    );
    if (!binding) {
      throw new Error("Governor owner-ingress envelope is not authorized by host configuration");
    }
  };
  const submitSignal = (
    envelope: AuthenticatedSignalOwnerEnvelope,
  ): HostGovernorOwnerIngressReceiptId => {
    assertExactObject(
      envelope,
      [
        "accountId",
        "gatewayInstanceId",
        "ownerPrincipal",
        "sourceSequence",
        "action",
        "scopeKey",
        "nonce",
        "observedAt",
        "expiresAt",
        "transportEventId",
      ],
      "Signal",
    );
    requireBinding({ channel: "signal", envelope });
    return submit({
      channel: "signal",
      accountId: envelope.accountId,
      gatewayInstanceId: envelope.gatewayInstanceId,
      ownerPrincipal: envelope.ownerPrincipal,
      sourceMessageId: envelope.transportEventId,
      sourceSequence: envelope.sourceSequence,
      action: envelope.action,
      scopeKey: envelope.scopeKey,
      nonce: envelope.nonce,
      observedAt: envelope.observedAt,
      expiresAt: envelope.expiresAt,
    });
  };
  const submitIMessage = (
    envelope: AuthenticatedIMessageOwnerEnvelope,
  ): HostGovernorOwnerIngressReceiptId => {
    assertExactObject(
      envelope,
      [
        "accountId",
        "gatewayInstanceId",
        "ownerPrincipal",
        "sourceSequence",
        "action",
        "scopeKey",
        "nonce",
        "observedAt",
        "expiresAt",
        "messageGuid",
        "subscriptionInstanceId",
      ],
      "iMessage",
    );
    if (envelope.subscriptionInstanceId !== envelope.gatewayInstanceId) {
      throw new Error("Governor iMessage subscription and gateway identities are mismatched");
    }
    requireBinding({ channel: "imessage", envelope });
    return submit({
      channel: "imessage",
      accountId: envelope.accountId,
      gatewayInstanceId: envelope.subscriptionInstanceId,
      ownerPrincipal: envelope.ownerPrincipal,
      sourceMessageId: envelope.messageGuid,
      sourceSequence: envelope.sourceSequence,
      action: envelope.action,
      scopeKey: envelope.scopeKey,
      nonce: envelope.nonce,
      observedAt: envelope.observedAt,
      expiresAt: envelope.expiresAt,
    });
  };
  return Object.freeze({ submitSignal, submitIMessage });
}
