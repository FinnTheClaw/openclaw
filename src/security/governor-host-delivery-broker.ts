/** Host-only immutable delivery registration, receipt signing, and revocation. */
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorHostDeliveryRuntime } from "./governor-host-channel-delivery.js";
import type {
  GovernorDeliveryManualResolution,
  GovernorTrustedDeliveryResolver,
  HostDeliveryEntry,
  HostDeliveryReceipt,
  HostGovernorCapabilities,
  HostGovernorDeliveryHandle,
} from "./governor-host-contracts.js";
import { createHostDeliveryImplementation } from "./governor-host-delivery-implementations.js";
import {
  assertGovernorDeliveryRegistrationInput,
  opaqueGovernorDeliveryId as opaqueId,
  signGovernorDelivery as sign,
} from "./governor-host-delivery-primitives.js";
import type { GovernorHostPersistence } from "./governor-host-persistence.js";
import type { GovernorSecrets } from "./governor-host-secrets.js";
const DELIVERY_AUTHORITIES = new WeakSet<object>();
const DELIVERY_RESOLVERS = new WeakSet<object>();
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
  resolveUnknown: HostGovernorCapabilities["resolveUnknownDelivery"];
  resolver: GovernorTrustedDeliveryResolver;
  close: () => void;
} {
  const key = params.secrets.receiptSigningKey;
  const authority = Object.freeze({});
  DELIVERY_AUTHORITIES.add(authority);
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("GOVERNOR_HOST_CAPABILITY_CLOSED");
    }
  };
  const register: HostGovernorCapabilities["registerStaticDeliveryAdapter"] = (input) => {
    assertOpen();
    assertGovernorDeliveryRegistrationInput(input);
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
    const effectFor = (request: {
      deliveryKey: string;
      payloadDigest: string;
      observedAt: number;
    }) => {
      const claimId = opaqueId(key, {
        deliveryEffect: {
          handle,
          deliveryKey: request.deliveryKey,
          payloadDigest: request.payloadDigest,
          generation: unsigned.generation,
          deploymentIdentity: unsigned.binding.deploymentIdentity,
        },
      });
      return {
        handle,
        identityKey,
        implementationDigest,
        configDigest,
        generation: unsigned.generation,
        signature,
        observedAt: request.observedAt,
        claimId,
        deploymentIdentity: unsigned.binding.deploymentIdentity,
        deliveryKey: request.deliveryKey,
        payloadDigest: request.payloadDigest,
      };
    };
    const send: HostDeliveryEntry["send"] = async (request) => {
      const payloadDigest = governorDigest(request.payload);
      const effect = effectFor({
        deliveryKey: request.deliveryKey,
        payloadDigest,
        observedAt: Date.now(),
      });
      if (!params.persistence.claimDeliveryEffect(effect)) {
        const priorState = params.persistence.deliveryEffectState(effect);
        if (priorState) {
          if (priorState === "effect_started") {
            params.persistence.markDeliveryEffectUnknown({
              ...effect,
              reasonDigest: governorDigest({ reason: "delivery_effect_already_admitted" }),
            });
          }
          return {
            status: "unknown",
            reasonDigest: governorDigest({
              reason: "delivery_effect_already_admitted",
              priorState,
            }),
            reconcileSupported: true,
          };
        }
        return {
          status: "not_sent",
          reasonDigest: governorDigest({ reason: "delivery_effect_claim_rejected" }),
        };
      }
      if (!params.persistence.startDeliveryEffect({ ...effect, observedAt: Date.now() })) {
        return {
          status: "not_sent",
          reasonDigest: governorDigest({ reason: "delivery_effect_start_rejected" }),
        };
      }
      if (implementation.mode === "shadow") {
        const result = {
          status: "would_send",
          receipt: issueReceipt({
            deliveryKey: request.deliveryKey,
            payloadDigest,
            outcome: "would_send",
            providerReceipt: { decision: "would_send" },
          }),
        } as const;
        params.persistence.completeDeliveryEffect(effect.claimId, Date.now());
        return result;
      }
      let result: Awaited<ReturnType<typeof implementation.send>>;
      try {
        result = await implementation.send(request);
      } catch {
        params.persistence.markDeliveryEffectUnknown({
          ...effect,
          observedAt: Date.now(),
          reasonDigest: governorDigest({ reason: "delivery_transport_interrupted" }),
        });
        throw new Error("GOVERNOR_DELIVERY_TRANSPORT_INTERRUPTED");
      }
      if (result.status === "sent") {
        const sent = {
          status: "sent",
          receipt: issueReceipt({
            deliveryKey: request.deliveryKey,
            payloadDigest,
            outcome: "sent",
            providerReceipt: result.providerReceipt,
          }),
        } as const;
        params.persistence.completeDeliveryEffect(effect.claimId, Date.now());
        return sent;
      }
      if (result.status === "not_sent") {
        params.persistence.completeDeliveryEffect(effect.claimId, Date.now());
      } else if (result.status === "unknown") {
        params.persistence.markDeliveryEffectUnknown({
          ...effect,
          observedAt: Date.now(),
          reasonDigest: result.reasonDigest,
        });
      }
      return result;
    };
    const reconcile: HostDeliveryEntry["reconcile"] = async (request) => {
      const effect = effectFor({ ...request, observedAt: Date.now() });
      params.persistence.markDeliveryEffectUnknown({
        ...effect,
        reasonDigest: governorDigest({ reason: "delivery_reconciliation_pending" }),
      });
      const result = await implementation.reconcile(request);
      if (result.status === "sent") {
        const reasonDigest = governorDigest({ reason: "authoritative_reconciliation_sent" });
        const body = {
          ...effect,
          resolution: "confirmed_sent" as const,
          reasonDigest,
          observedAt: Date.now(),
          keyId: "host-broker-v1" as const,
          keyVersion: 1 as const,
        };
        params.persistence.resolveDeliveryEffect({
          ...effect,
          observedAt: body.observedAt,
          resolution: body.resolution,
          reasonDigest,
          resolutionSignature: sign(key, body),
        });
        return {
          status: "sent",
          receipt: issueReceipt({
            ...request,
            outcome: "sent",
            providerReceipt: result.providerReceipt,
          }),
        };
      }
      if (result.status === "not_sent") {
        const reasonDigest = governorDigest({ reason: "authoritative_reconciliation_not_sent" });
        const body = {
          ...effect,
          resolution: "confirmed_not_sent" as const,
          reasonDigest,
          observedAt: Date.now(),
          keyId: "host-broker-v1" as const,
          keyVersion: 1 as const,
        };
        params.persistence.resolveDeliveryEffect({
          ...effect,
          observedAt: body.observedAt,
          resolution: body.resolution,
          reasonDigest,
          resolutionSignature: sign(key, body),
        });
      }
      return result;
    };
    params.deliveries.set(handle, Object.freeze({ ...unsigned, send, reconcile, signature }));
    return handle;
  };
  const revoke: HostGovernorCapabilities["revokeDeliveryAdapter"] = ({ handle }) => {
    assertOpen();
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
  const resolveUnknown: HostGovernorCapabilities["resolveUnknownDelivery"] = (input) => {
    assertOpen();
    if (!DELIVERY_AUTHORITIES.has(authority)) {
      throw new Error("Governor host delivery capability is invalid");
    }
    const entry = params.deliveries.get(input.handle);
    if (!entry || entry.status !== "certified") {
      return false;
    }
    const observedAt = Date.now();
    const effect = {
      handle: entry.handle,
      identityKey: entry.identityKey,
      implementationDigest: entry.implementationDigest,
      configDigest: entry.configDigest,
      generation: entry.generation,
      signature: entry.signature,
      observedAt,
      claimId: opaqueId(key, {
        deliveryEffect: {
          handle: entry.handle,
          deliveryKey: input.deliveryKey,
          payloadDigest: input.payloadDigest,
          generation: entry.generation,
          deploymentIdentity: entry.binding.deploymentIdentity,
        },
      }),
      deploymentIdentity: entry.binding.deploymentIdentity,
      deliveryKey: input.deliveryKey,
      payloadDigest: input.payloadDigest,
    };
    const reasonDigest = governorDigest({
      reason: "host_manual_delivery_resolution",
      resolution: input.resolution,
    });
    params.persistence.markDeliveryEffectUnknown({ ...effect, reasonDigest });
    const body = {
      ...effect,
      resolution: input.resolution as GovernorDeliveryManualResolution,
      reasonDigest,
      observedAt,
      keyId: "host-broker-v1" as const,
      keyVersion: 1 as const,
    };
    return params.persistence.resolveDeliveryEffect({
      ...effect,
      resolution: input.resolution,
      reasonDigest,
      resolutionSignature: sign(key, body),
    });
  };
  const resolver: GovernorTrustedDeliveryResolver = Object.freeze({
    resolve: (handle) => {
      if (closed) {
        return null;
      }
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
      if (closed) {
        return false;
      }
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
  return { register, revoke, resolveUnknown, resolver, close: () => (closed = true) };
}
