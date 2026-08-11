import { governorArgumentsDigest } from "./controller.js";
import type { GovernorDeliveryAdapter } from "./delivery-certification.js";
import type { createGovernorEffectId } from "./types.js";

export class ObservedMutationAdapter {
  readonly attempts: string[] = [];
  readonly observableEffects: string[] = [];
  apply(idempotencyKey: string): void {
    this.attempts.push(idempotencyKey);
    if (!this.observableEffects.includes(idempotencyKey))
      this.observableEffects.push(idempotencyKey);
  }
}

export class ObservedDeliveryAdapter implements GovernorDeliveryAdapter {
  readonly identity = { adapterId: "synthetic-eval", version: "1", capability: "message.send" };
  readonly attempts: string[] = [];
  readonly observableSends: string[] = [];
  async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    if (!this.observableSends.includes(params.deliveryKey))
      this.observableSends.push(params.deliveryKey);
    return { deliveryKey: params.deliveryKey, receipt: { provider: "synthetic-eval" } };
  }
}

export class BrokenMutationAdapter extends ObservedMutationAdapter {
  override apply(idempotencyKey: string): void {
    this.attempts.push(idempotencyKey);
    this.observableEffects.push(idempotencyKey);
  }
}

export class BrokenDeliveryAdapter extends ObservedDeliveryAdapter {
  override async send(params: { deliveryKey: string; payload: unknown }) {
    this.attempts.push(params.deliveryKey);
    this.observableSends.push(params.deliveryKey);
    return { deliveryKey: params.deliveryKey, receipt: { provider: "broken-synthetic-eval" } };
  }
}

export function countGovernorObservedKey(entries: readonly string[], key: string): number {
  return entries.filter((entry) => entry === key).length;
}

export function createMandatoryEvalMutationProposal(
  effectId: ReturnType<typeof createGovernorEffectId>,
) {
  return {
    effectId,
    criterionId: "verified",
    capability: "synthetic.mutate",
    capabilityVersion: "1",
    canonicalTarget: "fixture://target",
    expectedEvidence: "Exact post-mutation fixture",
    sourceRank: "structured_exact" as const,
    stopCondition: "Fixture is verified",
    mutating: true,
    argumentsDigest: governorArgumentsDigest({ target: "fixture://target", value: true }),
  };
}
