import type { GovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import type { GovernorAgentLoopRunScope } from "../security/governor-agent-loop-types.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type {
  GatewayBehaviorGovernorModuleActivation,
  GatewayBehaviorGovernorModuleRunInput,
} from "./behavior-governor-module-agent-loop.js";

declare const runBindingTokenBrand: unique symbol;
export type GatewayBehaviorGovernorModuleRunBindingToken = Readonly<{
  [runBindingTokenBrand]: true;
}>;

export type GatewayBehaviorGovernorModuleRunBinding = Readonly<{
  token: GatewayBehaviorGovernorModuleRunBindingToken;
  close: () => void;
}>;

export type GatewayBehaviorGovernorModuleRunBindingInput = Readonly<{
  run: GatewayBehaviorGovernorModuleRunInput["run"];
  planDigest: string;
  plan: Readonly<object>;
}>;

export type GatewayBehaviorGovernorModuleRunBindingAuthority = Readonly<{
  createRunBinding: (
    input: GatewayBehaviorGovernorModuleRunBindingInput,
  ) => GatewayBehaviorGovernorModuleRunBinding;
  resolveRunScope: (
    input: GatewayBehaviorGovernorModuleRunInput,
    token: GatewayBehaviorGovernorModuleRunBindingToken,
    provider: GovernorAgentLoopScopeProvider,
  ) => GovernorAgentLoopRunScope | undefined;
  freeze: () => void;
  close: () => void;
}>;

type BindingRecord = {
  provider?: GovernorAgentLoopScopeProvider;
  identityDigest: string;
  planDigest: string;
  plan: Readonly<object>;
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

export function createGatewayBehaviorGovernorModuleRunBindingAuthority(params: {
  activation: GatewayBehaviorGovernorModuleActivation;
}): GatewayBehaviorGovernorModuleRunBindingAuthority {
  const records = new Map<object, BindingRecord>();
  let frozen = false;
  let closed = false;

  const closeRecord = (token: object, record: BindingRecord): void => {
    if (record.closed) {
      return;
    }
    record.provider?.close();
    record.closed = true;
    records.delete(token);
  };

  return Object.freeze({
    createRunBinding(input) {
      if (frozen || closed) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_FROZEN");
      }
      if (!PLAN_DIGEST.test(input.planDigest) || !input.plan || !Object.isFrozen(input.plan)) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_PLAN_INVALID");
      }
      const token = Object.freeze({}) as GatewayBehaviorGovernorModuleRunBindingToken;
      const record: BindingRecord = {
        identityDigest: runIdentityDigest(input.run),
        planDigest: input.planDigest,
        plan: input.plan,
        consumed: false,
        closed: false,
      };
      records.set(token, record);
      return Object.freeze({ token, close: () => closeRecord(token, record) });
    },
    resolveRunScope(input, token, provider) {
      if (frozen || closed) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_FROZEN");
      }
      const record = token && typeof token === "object" ? records.get(token) : undefined;
      if (
        !record ||
        record.closed ||
        record.consumed ||
        !sameActivation(params.activation, input.activation) ||
        record.identityDigest !== runIdentityDigest(input.run) ||
        !PLAN_DIGEST.test(record.planDigest) ||
        !Object.isFrozen(record.plan)
      ) {
        throw new Error("GOVERNOR_MODULE_RUN_BINDING_INVALID");
      }
      record.consumed = true;
      record.provider = provider;
      try {
        const scope = provider.resolveRunScope(input.run);
        if (!scope) {
          throw new Error("GOVERNOR_MODULE_RUN_BINDING_SCOPE_MISMATCH");
        }
        return scope;
      } catch (error) {
        closeRecord(token, record);
        throw error;
      }
    },
    freeze() {
      frozen = true;
      for (const record of records.values()) {
        record.provider?.freeze();
      }
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
      closed = true;
    },
  });
}
