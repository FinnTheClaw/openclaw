import { describe, expect, it } from "vitest";
import {
  assertGovernorBoundarySafe,
  GovernorSecretRejectedError,
  scanGovernorSecrets,
} from "./secret-filter.js";

describe("governor secret field canonicalization", () => {
  it("rejects credential field spellings at any nested or array position", () => {
    const value = {
      outer: [
        { accessToken: "synthetic-value" },
        { Auth_Token: "synthetic-value" },
        { "OAUTH.TOKEN": "synthetic-value" },
        { clientSecret: "synthetic-value" },
        { PascalCaseApiKey: "synthetic-value" },
      ],
    } as unknown as Parameters<typeof scanGovernorSecrets>[0];
    const scan = scanGovernorSecrets(value);
    expect(scan.safe).toBe(false);
    expect(scan.findings).toHaveLength(5);
    expect(JSON.stringify(scan.redacted)).not.toContain("synthetic-value");
    expect(() => assertGovernorBoundarySafe("session", value)).toThrow(GovernorSecretRejectedError);
  });

  it("rejects camel, separator, and case variants even when values do not look secret", () => {
    const value = {
      apiKey: "opaque",
      "access-token": "opaque",
      "oauth.token": "opaque",
      "CLIENT SECRET": "opaque",
      authToken: "opaque",
    } as unknown as Parameters<typeof scanGovernorSecrets>[0];
    const scan = scanGovernorSecrets(value);
    expect(scan.safe).toBe(false);
    expect(scan.findings).toHaveLength(5);
    expect(JSON.stringify(scan.redacted)).not.toContain("opaque");
  });

  it("does not echo a rejected marker in the bounded error", () => {
    const marker = "SECRET_VALUE_SHOULD_NOT_ECHO";
    try {
      assertGovernorBoundarySafe("memory", { clientSecret: marker });
      throw new Error("expected secret rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernorSecretRejectedError);
      expect(String(error)).not.toContain(marker);
    }
  });
});
