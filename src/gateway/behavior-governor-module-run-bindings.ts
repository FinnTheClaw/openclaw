import type { GovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import type { GovernorAgentLoopRunScope } from "../security/governor-agent-loop-types.js";
import {
  canonicalGovernorJson,
  governorDigest,
  type GovernorJsonValue,
} from "../tasks/governor/canonical-json.js";
import { assertGovernorPersistedJson } from "../tasks/governor/persistence-guard.js";
import type {
  GatewayBehaviorGovernorModuleActivation,
  GatewayBehaviorGovernorModuleRunInput,
} from "./behavior-governor-module-agent-loop.js";

declare const runBindingTokenBrand: unique symbol;
export type GatewayBehaviorGovernorModuleRunBindingToken = Readonly<{
  [runBindingTokenBrand]: true;
}>;
export type GatewayBehaviorGovernorModuleRunBindingProof = Readonly<{
  token: GatewayBehaviorGovernorModuleRunBindingToken;
  planDigest: string;
  plan: GovernorJsonValue;
}>;
export type GatewayBehaviorGovernorModuleRunBinding = Readonly<{
  proof: GatewayBehaviorGovernorModuleRunBindingProof;
  close: () => void;
}>;
export type GatewayBehaviorGovernorModuleRunBindingInput = Readonly<{
  run: GatewayBehaviorGovernorModuleRunInput["run"];
  planDigest: string;
  plan: unknown;
}>;
export type GatewayBehaviorGovernorModuleRunBindingAuthority = Readonly<{
  createRunBinding: (
    input: GatewayBehaviorGovernorModuleRunBindingInput,
  ) => GatewayBehaviorGovernorModuleRunBinding;
  resolveRunScope: (
    input: GatewayBehaviorGovernorModuleRunInput,
    proof: GatewayBehaviorGovernorModuleRunBindingProof,
  ) => GovernorAgentLoopRunScope | undefined;
  freeze: () => void;
  close: () => void;
}>;

type BindingRecord = {
  identityDigest: string;
  planDigest: string;
  plan: GovernorJsonValue;
  consumed: boolean;
  closed: boolean;
};

const PLAN_DIGEST = /^[a-f0-9]{64}$/u;

function sameActivation(
  left: GatewayBehaviorGovernorModuleActivation,
  right: GatewayBehaviorGovernorModuleActivation,
): boolean {
  return left.id === right.id && left.mode === right.mode && left.version === right.version;
}

function runIdentityDigest(run: GatewayBehaviorGovernorModuleRunInput["run"]): string {
  return governorDigest({
    runId: run.runId,
    sessionKey: run.sessionKey,
    sessionId: run.sessionId,
    agentId: run.agentId,
    workspaceId: run.workspaceId,
    channel: run.channel,
    accountId: run.accountId,
    principalId: run.principalId,
    conversationId: run.conversationId,
    sourceMessageId: run.sourceMessageId,
    sourceSequence: run.sourceSequence ?? null,
    promptDigest: governorDigest(run.prompt),
  });
}

function deepFreeze(value: GovernorJsonValue): GovernorJsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalPlan(plan: unknown): GovernorJsonValue {
  const safe = assertGovernorPersistedJson("log", plan);
  return deepFreeze(JSON.parse(canonicalGovernorJson(safe)) as GovernorJsonValue);
}

export function createGatewayBehaviorGovernorModuleRunBindingAuthority(params: {
  activation: GatewayBehaviorGovernorModuleActivation;
  provider: GovernorAgentLoopScopeProvider;
}): GatewayBehaviorGovernorModuleRunBindingAuthority {
  const records = new Map<object, BindingRecord>();
  let frozen = false;
  let closed = false;
  let providerClosed = false;

  const closeProvider = (): void => {
    if (providerClosed) {
      return;
    }
    params.provider.close();
    providerClosed = true;
  };

  const closeRecord = (token: object, record: BindingRecord): void => {
    if (record.closed) {
      return;
    }
    if (record.consumed) {
      closeProvider();
    }
    record.closed = true;
    records.delete(token);
  };

  return Object.freeze({
    createRunBinding(input) {
      if (frozen || closed) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_FROZEN");
      }
      const plan = canonicalPlan(input.plan);
      const planDigest = governorDigest(plan);
      if (!PLAN_DIGEST.test(input.planDigest) || input.planDigest !== planDigest) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_PLAN_INVALID");
      }
      const token = Object.freeze({}) as GatewayBehaviorGovernorModuleRunBindingToken;
      const record: BindingRecord = {
        identityDigest: runIdentityDigest(input.run),
        planDigest,
        plan,
        consumed: false,
        closed: false,
      };
      records.set(token, record);
      const proof = Object.freeze({ token, planDigest, plan });
      return Object.freeze({ proof, close: () => closeRecord(token, record) });
    },
    resolveRunScope(input, proof) {
      if (frozen || closed) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_FROZEN");
      }
      const record =
        proof?.token && typeof proof.token === "object" ? records.get(proof.token) : undefined;
      if (
        !record ||
        record.closed ||
        record.consumed ||
        !sameActivation(params.activation, input.activation) ||
        record.identityDigest !== runIdentityDigest(input.run) ||
        proof.plan !== record.plan ||
        proof.planDigest !== record.planDigest ||
        governorDigest(proof.plan) !== record.planDigest
      ) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_INVALID");
      }
      record.consumed = true;
      try {
        const scope = params.provider.resolveRunScope(input.run);
        if (!scope) {
          throw new Error("GOVERNOR_MODULE_RUN_BINDING_SCOPE_MISMATCH");
        }
        return scope;
      } catch (error) {
        closeRecord(proof.token, record);
        throw error;
      }
    },
    freeze() {
      frozen = true;
      params.provider.freeze();
    },
    close() {
      if (closed) {
        return;
      }
      frozen = true;
      const errors: unknown[] = [];
      for (const [opaque, record] of [...records].toReversed()) {
        try {
          closeRecord(opaque, record);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0 || records.size > 0) {
        throw new AggregateError(errors, "GOVERNOR_MODULE_RUN_BINDING_CLOSE_FAILED");
      }
      closeProvider();
      closed = true;
    },
  });
}
