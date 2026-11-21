import type { CallId, CallRecord } from "../types.js";

/** Resolve an active call through the index maintained by call mutations. */
export function getCallByProviderCallId(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  providerCallId: string;
}): CallRecord | undefined {
  const callId = params.providerCallIdMap.get(params.providerCallId);
  if (callId) {
    const mappedCall = params.activeCalls.get(callId);
    if (mappedCall) {
      return mappedCall;
    }
  }

  for (const call of params.activeCalls.values()) {
    if (call.providerCallId === params.providerCallId) {
      return call;
    }
  }
  return undefined;
}

export function findCall(params: {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  callIdOrProviderCallId: string;
}): CallRecord | undefined {
  return (
    params.activeCalls.get(params.callIdOrProviderCallId) ??
    getCallByProviderCallId({
      activeCalls: params.activeCalls,
      providerCallIdMap: params.providerCallIdMap,
      providerCallId: params.callIdOrProviderCallId,
    })
  );
}
