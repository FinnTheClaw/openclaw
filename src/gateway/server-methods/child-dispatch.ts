import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { findSubagentChildIntent } from "../../agents/subagent-child-intent-store.sqlite.js";
import { resolveSubagentChildOperationIdentity } from "../../agents/subagent-child-operation-identity.js";
import { readGatewayAcceptanceReceiptSigner } from "../../agents/subagent-gateway-acceptance-receipt-runtime.js";
import { buildSubagentChildAdmissionCapability } from "../../agents/subagent-governed-admission.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  mintAgentRuntimeIdentityToken,
  type AgentRuntimeIdentity,
} from "../agent-runtime-identity-token.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestHandlers } from "./types.js";

function isPrivateChildDispatchClient(
  client: Parameters<GatewayRequestHandlers["agent"]>[0]["client"],
): boolean {
  return Boolean(
    client?.connect.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    client.connect.client.mode === GATEWAY_CLIENT_MODES.BACKEND &&
    client.internal?.agentRuntimeIdentity?.childAdmission,
  );
}

function hasCompleteChildBinding(params: Record<string, unknown>): boolean {
  return (
    params.childIntentReceiptMode === "governed" &&
    params.childIntentCapability === "sessions_spawn" &&
    typeof params.childIntentRequestDigest === "string" &&
    typeof params.childIntentResolvedDigest === "string" &&
    typeof params.childIntentControllerSessionKey === "string" &&
    typeof params.childIntentCanonicalKey === "string" &&
    (params.childIntentIdentityKind === "operation" ||
      params.childIntentIdentityKind === "canonical") &&
    typeof params.childIntentIdentityValue === "string"
  );
}

function readChildDispatchParams(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isTrustedBackendWithIdentity(
  client: Parameters<typeof agentHandlers.agent>[0]["client"],
): AgentRuntimeIdentity | undefined {
  if (
    client?.connect.client.id !== GATEWAY_CLIENT_IDS.GATEWAY_CLIENT ||
    client.connect.client.mode !== GATEWAY_CLIENT_MODES.BACKEND
  ) {
    return undefined;
  }
  return client.internal?.agentRuntimeIdentity;
}

function rejectChildDispatch(opts: Parameters<typeof agentHandlers.agent>[0], message: string) {
  opts.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

export const childDispatchHandlers: GatewayRequestHandlers = {
  "child.dispatch.prepare": async (opts) => {
    const identity = isTrustedBackendWithIdentity(opts.client);
    const params = readChildDispatchParams(opts.params);
    if (
      !identity ||
      identity.childAdmission ||
      !params ||
      typeof params.agentId !== "string" ||
      typeof params.sessionKey !== "string" ||
      !hasCompleteChildBinding(params) ||
      readGatewayAcceptanceReceiptSigner() === undefined
    ) {
      rejectChildDispatch(opts, "child dispatch preparation requires trusted receipt authority");
      return;
    }
    const childIdentity = resolveSubagentChildOperationIdentity({
      controllerSessionKey: params.childIntentControllerSessionKey as string,
      canonicalKey: params.childIntentCanonicalKey as string,
      operationKey:
        params.childIntentIdentityKind === "operation"
          ? (params.childIntentIdentityValue as string)
          : undefined,
    });
    if (
      identity.sessionKey !== childIdentity.controllerSessionKey ||
      identity.agentId !== params.agentId
    ) {
      rejectChildDispatch(opts, "child dispatch identity is not bound to the trusted controller");
      return;
    }
    const reservation = findSubagentChildIntent(
      params.childIntentCanonicalKey as string,
      childIdentity.controllerSessionKey,
      childIdentity.identityKind === "operation" ? childIdentity.identityValue : undefined,
    );
    if (
      !reservation ||
      reservation.spawnAdmission !== "dispatching" ||
      reservation.childSessionKey !== params.sessionKey ||
      reservation.childIntentRequestDigest !== params.childIntentRequestDigest ||
      reservation.childIntentBehaviorDigest !== params.childIntentResolvedDigest ||
      reservation.childIntentTargetAgentId !== params.agentId
    ) {
      rejectChildDispatch(opts, "child dispatch capability is not bound to an active reservation");
      return;
    }
    const capability = buildSubagentChildAdmissionCapability({
      agentId: params.agentId,
      childSessionKey: params.sessionKey,
      identity: childIdentity,
      requestDigest: params.childIntentRequestDigest as string,
      resolvedDigest: params.childIntentResolvedDigest as string,
      gatewayGeneration: getAgentEventLifecycleGeneration(),
    });
    const token = mintAgentRuntimeIdentityToken(capability);
    opts.respond(true, { agentRuntimeIdentityToken: token }, undefined);
  },
  "child.dispatch": async (opts) => {
    if (!isPrivateChildDispatchClient(opts.client) || !hasCompleteChildBinding(opts.params)) {
      rejectChildDispatch(opts, "child.dispatch requires a trusted local backend capability");
      return;
    }
    await agentHandlers.agent({
      ...opts,
      req: { ...opts.req, method: "child.dispatch" },
    });
  },
};
