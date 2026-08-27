import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const refs = {
  identityHmacKey: { source: "env", provider: "default", id: "GOV_IDENTITY" },
  evidenceAdmissionKey: { source: "env", provider: "default", id: "GOV_EVIDENCE" },
  receiptSigningKey: { source: "env", provider: "default", id: "GOV_RECEIPT" },
  ledgerSigningKey: { source: "env", provider: "default", id: "GOV_LEDGER" },
  deploymentIdentity: { source: "env", provider: "default", id: "GOV_DEPLOYMENT" },
} as const;

function config(secretRefs: unknown = refs) {
  return {
    experimental: {
      behaviorGovernor: {
        enabled: true,
        mode: "shadow",
        secretRefs,
        agentLoop: {
          scopes: [{ sessionKey: "fixture-session" }],
          criteria: [],
          toolBindings: [],
          maxTurns: 3,
        },
      },
    },
  };
}

describe("behavior governor config boundary", () => {
  it("accepts the typed canonical SecretRef surface", () => {
    expect(OpenClawSchema.safeParse(config()).success).toBe(true);
  });

  it("accepts an empty modular plan without legacy secrets", () => {
    expect(
      OpenClawSchema.safeParse({
        experimental: { behaviorGovernor: { modules: [] } },
      }).success,
    ).toBe(true);
  });

  it("accepts only data-only module selections", () => {
    const module = {
      id: "C04A.1",
      mode: "shadow",
      version: "1.0.0",
    };
    expect(
      OpenClawSchema.safeParse({
        experimental: { behaviorGovernor: { modules: [module] } },
      }).success,
    ).toBe(true);
    for (const replacement of [
      { ...module, id: "../../module" },
      { ...module, mode: "disabled" },
      { ...module, version: "" },
      { ...module, implementationDigest: "a".repeat(64) },
      { ...module, modulePath: "./untrusted.js" },
    ]) {
      expect(
        OpenClawSchema.safeParse({
          experimental: { behaviorGovernor: { modules: [replacement] } },
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    { identityHmacKey: "plaintext-secret" },
    { identityHmacKey: { source: "file", provider: "default", id: "../secret" } },
    { identityHmacKey: { source: "exec", provider: "default", id: "a/../b" } },
    { identityHmacKey: { source: "env", provider: "default", id: "lowercase" } },
  ])("rejects malformed or plaintext SecretRefs: %j", (replacement) => {
    expect(OpenClawSchema.safeParse(config({ ...refs, ...replacement })).success).toBe(false);
  });

  it("rejects extra governor policy fields at the schema boundary", () => {
    expect(
      OpenClawSchema.safeParse({
        ...config(),
        experimental: {
          behaviorGovernor: {
            ...config().experimental.behaviorGovernor,
            untrustedFactory: "module-path",
          },
        },
      }).success,
    ).toBe(false);
  });
});
