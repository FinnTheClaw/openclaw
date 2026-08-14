import { mintAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import { buildSubagentChildAdmissionCapability } from "../subagent-governed-admission.js";

/**
 * Gateway mock helper for subagent-spawn tests that only require accepted RPC responses.
 */
/** Installs a gateway mock that accepts `agent` and `sessions.*` calls. */
export function installAcceptedSubagentGatewayMock(mock: {
  mockImplementation: (
    impl: (opts: { method?: string; params?: unknown }) => Promise<unknown>,
  ) => unknown;
}) {
  mock.mockImplementation(async ({ method, params }) => {
    if (method === "child.dispatch.prepare") {
      const input = params as {
        agentId?: string;
        sessionKey?: string;
        childIntentControllerSessionKey?: string;
        childIntentIdentityKind?: "operation" | "canonical";
        childIntentIdentityValue?: string;
        childIntentRequestDigest?: string;
        childIntentResolvedDigest?: string;
      };
      const identity = {
        controllerSessionKey: input.childIntentControllerSessionKey ?? "agent:main:main",
        identityKind: input.childIntentIdentityKind ?? "canonical",
        identityValue: input.childIntentIdentityValue ?? "test-child",
      } as const;
      const capability = buildSubagentChildAdmissionCapability({
        agentId: input.agentId ?? "main",
        childSessionKey: input.sessionKey ?? "agent:main:subagent:test-child",
        identity,
        requestDigest: input.childIntentRequestDigest ?? "test-request",
        resolvedDigest: input.childIntentResolvedDigest ?? "test-resolved",
        gatewayGeneration: "test-gateway",
      });
      return { agentRuntimeIdentityToken: mintAgentRuntimeIdentityToken(capability) };
    }
    return method === "agent" || method === "child.dispatch"
      ? { runId: "run-1" }
      : method?.startsWith("sessions.")
        ? { ok: true }
        : {};
  });
}
