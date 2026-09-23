import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconstructWebhookUrl, verifyTwilioWebhook } from "./webhook-security.js";

const body = "CallSid=R7&CallStatus=completed";
const authToken = "round-seven-token";
function context(headers: Record<string, string>) {
  return {
    headers,
    rawBody: body,
    url: "http://localhost:3000/voice/webhook?case=r7",
    method: "POST" as const,
  };
}
function signature(url: string) {
  return crypto
    .createHmac("sha1", authToken)
    .update(url + "CallSidR7CallStatuscompleted")
    .digest("base64");
}

describe("round-seven signed webhook host authority", () => {
  it("VH01 verifies an allowed trusted forwarded domain with public port", () => {
    const url = "https://proxy.example:8443/voice/webhook?case=r7";
    const result = verifyTwilioWebhook(
      context({
        host: "localhost:3000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "proxy.example:8443",
        "x-twilio-signature": signature(url),
      }),
      authToken,
      { allowedHosts: ["proxy.example"] },
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(url);
  });

  it("VH02 verifies an allowed trusted bracketed IPv6 host with public port", () => {
    const url = "https://[2001:db8::1]:8443/voice/webhook?case=r7";
    const result = verifyTwilioWebhook(
      context({
        host: "localhost:3000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "[2001:db8::1]:8443",
        "x-twilio-signature": signature(url),
      }),
      authToken,
      { allowedHosts: ["[2001:db8::1]"] },
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(url);
  });

  it("VH03 retains host-only behavior without a forwarded port", () => {
    expect(
      reconstructWebhookUrl(
        context({ host: "localhost:3000", "x-forwarded-host": "proxy.example" }),
        { allowedHosts: ["proxy.example"] },
      ),
    ).toBe("https://proxy.example/voice/webhook?case=r7");
  });

  it("VH04 ignores untrusted forwarded host and retains direct Host port", () => {
    expect(
      reconstructWebhookUrl(
        context({ host: "direct.example:8443", "x-forwarded-host": "attacker.example:9999" }),
      ),
    ).toBe("https://direct.example:8443/voice/webhook?case=r7");
  });

  it("VH05 retains direct bracketed IPv6 Host port", () => {
    expect(reconstructWebhookUrl(context({ host: "[2001:db8::2]:8443" }))).toBe(
      "https://[2001:db8::2]:8443/voice/webhook?case=r7",
    );
  });

  it("VH06 rejects an unallowed forwarded host and falls back to direct Host", () => {
    expect(
      reconstructWebhookUrl(
        context({ host: "direct.example:8443", "x-forwarded-host": "attacker.example:9999" }),
        { allowedHosts: ["approved.example"] },
      ),
    ).toBe("https://direct.example:8443/voice/webhook?case=r7");
  });

  it("VH07 rejects a nonnumeric forwarded port", () => {
    expect(
      reconstructWebhookUrl(
        context({ host: "direct.example:8443", "x-forwarded-host": "approved.example:abc" }),
        { allowedHosts: ["approved.example"] },
      ),
    ).toBe("https://direct.example:8443/voice/webhook?case=r7");
  });

  it("VH08 rejects zero and out-of-range forwarded ports", () => {
    for (const forwarded of ["approved.example:0", "approved.example:65536"]) {
      expect(
        reconstructWebhookUrl(
          context({ host: "direct.example:8443", "x-forwarded-host": forwarded }),
          { allowedHosts: ["approved.example"] },
        ),
      ).toBe("https://direct.example:8443/voice/webhook?case=r7");
    }
  });

  it("VH09 uses only the first comma-separated forwarded authority", () => {
    expect(
      reconstructWebhookUrl(
        context({
          host: "direct.example",
          "x-forwarded-host": "first.example:8443, second.example:9443",
        }),
        { allowedHosts: ["first.example", "second.example"] },
      ),
    ).toBe("https://first.example:8443/voice/webhook?case=r7");
  });

  it("VH10 honors configured publicUrl regardless of forwarded port", () => {
    const url = "https://public.example:9443/custom/webhook?case=r7";
    const result = verifyTwilioWebhook(
      context({
        host: "localhost:3000",
        "x-forwarded-host": "proxy.example:8443",
        "x-twilio-signature": signature(url),
      }),
      authToken,
      { allowedHosts: ["proxy.example"], publicUrl: "https://public.example:9443/custom/webhook" },
    );
    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(url);
  });
});
