/** Host-only immutable delivery registration, receipt signing, and revocation. */
import crypto from "node:crypto";
import {
  canonicalGovernorJson,
  governorDigest,
  type GovernorJsonValue,
} from "../tasks/governor/canonical-json.js";
import type { GovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import type {
  GovernorTrustedDeliveryResolver,
  HostDeliveryEntry,
  HostDeliveryReceipt,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
} from "./governor-host-contracts.js";
import { createHostDeliveryImplementation } from "./governor-host-delivery-implementations.js";
import type { GovernorHostPersistence } from "./governor-host-persistence.js";
import type { GovernorSecrets } from "./governor-host-secrets.js";

const DELIVERY_AUTHORITIES = new WeakSet<object>();
const DELIVERY_RESOLVERS = new WeakSet<object>();

function sign(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function opaqueId(key: string, value: GovernorJsonValue): string {
  return `ghr_${crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex")}`;
}

function assertRegistrationInput(
  input: Parameters<HostGovernorCapabilities["registerStaticDeliveryAdapter"]>[0],
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "Governor host delivery registration accepts only implementationId, config, and generation",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) =>
        typeof key === "symbol" ||
        (key !== "implementationId" && key !== "config" && key !== "generation") ||
        !("value" in descriptors[key]),
    )
  ) {
    throw new Error(
      "Governor host delivery registration accepts only implementationId, config, and generation",
    );
  }
}

export function isTrustedGovernorDeliveryResolver(
  resolver: GovernorTrustedDeliveryResolver,
): boolean {
  return DELIVERY_RESOLVERS.has(resolver);
}

export function createHostGovernorDeliveryBroker(params: {
  secrets: GovernorSecrets;
  persistence: GovernorHostPersistence;
  deliveries: Map<HostGovernorDeliveryHandle, HostDeliveryEntry>;
  deliveryRuntime?: GovernorHostDeliveryRuntime;
}): {
  register: HostGovernorCapabilities["registerStaticDeliveryAdapter"];
  revoke: HostGovernorCapabilities["revokeDeliveryAdapter"];
  resolver: GovernorTrustedDeliveryResolver;
} {
  const key = params.secrets.receiptSigningKey;
  const authority = Object.freeze({});
  DELIVERY_AUTHORITIES.add(authority);

  const register: HostGovernorCapabilities["registerStaticDeliveryAdapter"] = (input) => {
    assertRegistrationInput(input);
    if (
      !DELIVERY_AUTHORITIES.has(authority) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    ) {
      throw new Error("Governor host delivery capability is invalid");
    }
    const implementation = createHostDeliveryImplementation({
      implementationId: input.implementationId,
      config: input.config,
      mode: params.secrets.runtimeMode,
      runtime: params.deliveryRuntime,
    });
    const { identity } = implementation;
    const priorIdentity = Array.from(params.deliveries.values()).find(
      (entry) =>
        entry.identity.adapterId === identity.adapterId &&
        entry.identity.version === identity.version &&
        entry.identity.capability === identity.capability,
    );
    if (priorIdentity && input.generation <= priorIdentity.generation) {
      throw new Error("Governor delivery identity generation is already registered");
    }
    const identityKey = opaqueId(key, { deliveryIdentity: identity });
    const configDigest = governorDigest(implementation.config);
    const implementationDigest = implementation.implementationDigest;
    const handle = opaqueId(key, {
      delivery: { identity, configDigest, implementationDigest, generation: input.generation },
    }) as HostGovernorDeliveryHandle;
    const prior = params.deliveries.get(handle);
    if (prior && prior.status !== "revoked") {
      throw new Error("Governor delivery handle is already registered");
    }
    const unsigned = {
      handle,
      identityKey,
      identity,
      implementationId: implementation.implementationId,
      implementationDigest,
      configDigest,
      generation: input.generation,
      status: "certified" as const,
      binding: Object.freeze({
        channel: implementation.channel,
        accountIdentity: params.secrets.identity.opaqueReference(
          `delivery-account:${implementation.channel}`,
          implementation.accountId,
        ),
        targetIdentity: params.secrets.identity.opaqueReference(
          `delivery-target:${implementation.channel}`,
          implementation.normalizedTarget,
        ),
        deploymentIdentity: params.secrets.deploymentIdentity,
        mode: implementation.mode,
      }),
    };
    const signature = sign(key, unsigned);
    params.persistence.certifyDelivery({
      handle,
      identityKey,
      implementationDigest,
      configDigest,
      generation: input.generation,
      signature,
      observedAt: Date.now(),
    });

    const issueReceipt = (receipt: {
      deliveryKey: string;
      payloadDigest: string;
      outcome: "sent" | "would_send";
      providerReceipt: GovernorJsonValue;
    }): HostDeliveryReceipt => {
      const body = {
        kind: "host_delivery_receipt" as const,
        handle,
        identityKey,
        implementationDigest,
        configDigest,
        generation: unsigned.generation,
        deploymentIdentity: unsigned.binding.deploymentIdentity,
        deliveryKey: receipt.deliveryKey,
        payloadDigest: receipt.payloadDigest,
        outcome: receipt.outcome,
        providerReceiptDigest: governorDigest(receipt.providerReceipt),
        observedAt: Date.now(),
        keyId: "host-broker-v1" as const,
        keyVersion: 1 as const,
      };
      return Object.freeze({ ...body, signature: sign(key, body) });
    };
    const send: HostDeliveryEntry["send"] = async (request) => {
      const payloadDigest = governorDigest(request.payload);
      if (implementation.mode === "shadow") {
        return {
          status: "would_send",
          receipt: issueReceipt({
            deliveryKey: request.deliveryKey,
            payloadDigest,
            outcome: "would_send",
            providerReceipt: { decision: "would_send" },
          }),
        };
      }
      const result = await implementation.send(request);
      return result.status === "sent"
        ? {
            status: "sent",
            receipt: issueReceipt({
              deliveryKey: request.deliveryKey,
              payloadDigest,
              outcome: "sent",
              providerReceipt: result.providerReceipt,
            }),
          }
        : result;
    };
    const reconcile: HostDeliveryEntry["reconcile"] = async (request) => {
      const result = await implementation.reconcile(request);
      return result.status === "sent"
        ? {
            status: "sent",
            receipt: issueReceipt({
              ...request,
              outcome: "sent",
              providerReceipt: result.providerReceipt,
            }),
          }
        : result;
    };
    params.deliveries.set(handle, Object.freeze({ ...unsigned, send, reconcile, signature }));
    return handle;
  };

  const revoke: HostGovernorCapabilities["revokeDeliveryAdapter"] = ({ handle }) => {
    if (!DELIVERY_AUTHORITIES.has(authority)) {
      throw new Error("Governor host delivery capability is invalid");
    }
    const prior = params.deliveries.get(handle);
    if (!prior || prior.status === "revoked") {
      return false;
    }
    const unsigned = {
      handle: prior.handle,
      identityKey: prior.identityKey,
      identity: prior.identity,
      implementationId: prior.implementationId,
      implementationDigest: prior.implementationDigest,
      configDigest: prior.configDigest,
      generation: prior.generation + 1,
      status: "revoked" as const,
      binding: prior.binding,
    };
    const signature = sign(key, unsigned);
    if (
      !params.persistence.revokeDelivery({
        handle: prior.handle,
        identityKey: prior.identityKey,
        implementationDigest: prior.implementationDigest,
        configDigest: prior.configDigest,
        generation: unsigned.generation,
        signature,
        observedAt: Date.now(),
      })
    ) {
      throw new Error("Governor delivery revocation was not durably applied");
    }
    params.deliveries.set(
      handle,
      Object.freeze({
        ...unsigned,
        send: prior.send,
        reconcile: prior.reconcile,
        signature,
      }),
    );
    return true;
  };

  const resolver: GovernorTrustedDeliveryResolver = Object.freeze({
    resolve: (handle) => {
      const entry = params.deliveries.get(handle);
      if (!entry) {
        return null;
      }
      const durableState = params.persistence.deliveryState(entry.identityKey);
      const bindingMatches = params.persistence.deliveryBindingMatches({
        handle: entry.handle,
        identityKey: entry.identityKey,
        implementationDigest: entry.implementationDigest,
        configDigest: entry.configDigest,
        generation: entry.generation,
        signature: entry.signature,
        observedAt: 0,
        status: entry.status,
      });
      if (
        !durableState ||
        durableState.generation !== entry.generation ||
        durableState.status !== "certified" ||
        !bindingMatches
      ) {
        return null;
      }
      const { send: _send, reconcile: _reconcile, signature, ...unsigned } = entry;
      return sign(key, unsigned) === signature ? entry : null;
    },
    verifyReceipt: (receipt) => {
      const entry = params.deliveries.get(receipt.handle);
      if (!entry || entry.status !== "certified") {
        return false;
      }
      const { signature, ...body } = receipt;
      return (
        receipt.kind === "host_delivery_receipt" &&
        receipt.keyId === "host-broker-v1" &&
        receipt.keyVersion === 1 &&
        receipt.identityKey === entry.identityKey &&
        receipt.implementationDigest === entry.implementationDigest &&
        receipt.configDigest === entry.configDigest &&
        receipt.generation === entry.generation &&
        receipt.deploymentIdentity === entry.binding.deploymentIdentity &&
        sign(key, body) === signature &&
        params.persistence.deliveryBindingMatches({
          handle: entry.handle,
          identityKey: entry.identityKey,
          implementationDigest: entry.implementationDigest,
          configDigest: entry.configDigest,
          generation: entry.generation,
          signature: entry.signature,
          observedAt: receipt.observedAt,
          status: entry.status,
        })
      );
    },
  });
  DELIVERY_RESOLVERS.add(resolver);
  return { register, revoke, resolver };
}
