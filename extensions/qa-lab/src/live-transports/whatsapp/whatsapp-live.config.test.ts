import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";

type Overrides = NonNullable<Parameters<typeof buildWhatsAppQaConfig>[1]["overrides"]>;

function buildTools(
  baseTools: OpenClawConfig["tools"] = {},
  overrides: Overrides = { actions: true, audioPreflight: true },
) {
  return buildWhatsAppQaConfig({ tools: baseTools } as OpenClawConfig, {
    allowFrom: ["+15551234567"],
    authDir: "/tmp/qa-whatsapp-auth",
    dmPolicy: "allowlist",
    ownerAllowFrom: ["+15551234567"],
    overrides,
    sutAccountId: "qa-sut",
  }).tools;
}

describe("WhatsApp QA combined action and audio-preflight tools", () => {
  it("adds the message action tool", () => {
    expect(buildTools()?.alsoAllow).toEqual(["message"]);
  });

  it("retains an existing allowed tool", () => {
    expect(buildTools({ alsoAllow: ["exec"] })?.alsoAllow).toEqual(["exec", "message"]);
  });

  it("does not duplicate an existing message tool", () => {
    expect(buildTools({ alsoAllow: ["message"] })?.alsoAllow).toEqual(["message"]);
  });

  it("enables media audio preflight", () => {
    expect(buildTools()?.media?.audio?.enabled).toBe(true);
  });

  it("overrides disabled base media audio", () => {
    expect(buildTools({ media: { audio: { enabled: false } } })?.media?.audio?.enabled).toBe(true);
  });

  it("prepends the transcription model", () => {
    expect(buildTools()?.media?.models?.[0]?.model).toBe("gpt-4o-transcribe");
  });

  it("retains an existing media model", () => {
    const tools = buildTools({
      media: { models: [{ provider: "openai", model: "existing-model", capabilities: ["audio"] }] },
    });
    expect(tools?.media?.models?.[1]?.model).toBe("existing-model");
  });

  it("retains base tool denials", () => {
    expect(buildTools({ deny: ["read"] })?.deny).toEqual(["read"]);
  });

  it("retains audio preflight without actions", () => {
    expect(buildTools({}, { audioPreflight: true })?.media?.audio?.enabled).toBe(true);
  });

  it("retains base media without audio preflight", () => {
    expect(
      buildTools({ media: { audio: { enabled: false } } }, { actions: true })?.media?.audio
        ?.enabled,
    ).toBe(false);
  });
});
