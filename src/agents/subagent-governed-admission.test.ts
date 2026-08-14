import { describe, expect, it } from "vitest";
import {
  resolveSubagentChildOperationAcceptanceKey,
  resolveSubagentChildOperationIdentity,
} from "./subagent-child-operation-identity.js";
import {
  buildSubagentChildAdmissionCapability,
  isSubagentChildAdmissionCapabilityValid,
} from "./subagent-governed-admission.js";

describe("governed child admission capability", () => {
  const identity = resolveSubagentChildOperationIdentity({
    controllerSessionKey: "agent:main:main",
    canonicalKey: "canonical-child",
    operationKey: "slot-a",
  });

  it("binds the capability to the host-issued child identity and expiry", () => {
    const capability = buildSubagentChildAdmissionCapability({
      agentId: "main",
      childSessionKey: "agent:main:subagent:child",
      identity,
      requestDigest: "request-digest",
      resolvedDigest: "resolved-digest",
      gatewayGeneration: "gateway-generation",
      now: 10_000,
    });
    const expected = {
      agentId: "main",
      childSessionKey: "agent:main:subagent:child",
      identity,
      requestDigest: "request-digest",
      resolvedDigest: "resolved-digest",
      gatewayGeneration: "gateway-generation",
      now: 10_001,
    };
    expect(isSubagentChildAdmissionCapabilityValid({ identity: capability, expected })).toBe(true);
    expect(
      isSubagentChildAdmissionCapabilityValid({
        identity: capability,
        expected: { ...expected, requestDigest: "other-request" },
      }),
    ).toBe(false);
    expect(
      isSubagentChildAdmissionCapabilityValid({
        identity: capability,
        expected: { ...expected, now: capability.childAdmission!.expiresAtMs + 1 },
      }),
    ).toBe(false);
  });

  it("keeps named operation slots distinct without exposing the caller label as a receipt key", () => {
    const slotB = resolveSubagentChildOperationIdentity({
      controllerSessionKey: identity.controllerSessionKey,
      canonicalKey: "canonical-child",
      operationKey: "slot-b",
    });
    const keyA = resolveSubagentChildOperationAcceptanceKey(identity);
    const keyB = resolveSubagentChildOperationAcceptanceKey(slotB);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toContain("slot-a");
    expect(keyB).not.toContain("slot-b");
  });
});
