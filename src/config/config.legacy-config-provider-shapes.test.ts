import { describe, expect, it } from "vitest";
import { normalizeLegacyTalkConfig } from "../commands/doctor/shared/legacy-talk-config-normalizer.js";
import type { OpenClawConfig } from "./types.js";

describe("legacy provider-shaped config snapshots", () => {
  it("preserves provider-owned legacy Talk fields for the provider doctor migration", () => {
    const raw = {
      talk: {
        voiceAliases: {
          Clawd: "VoiceAlias1234567890",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
      },
    };
    const changes: string[] = [];
    const migrated = normalizeLegacyTalkConfig(raw as unknown as OpenClawConfig, changes);

    expect(changes).toEqual([]);
    expect(migrated).toEqual(raw);
  });

  it("preserves a providerless Talk reference during Doctor normalization", () => {
    const legacyRef = { source: "env", id: "OPENCLAW_TEST_UNUSED_TALK_REFERENCE" };
    const raw = {
      talk: {
        agentId: " ops ",
        provider: "demo",
        providers: { demo: { voiceId: "demo-voice", apiKey: legacyRef } },
      },
    };
    const migrated = normalizeLegacyTalkConfig(raw as unknown as OpenClawConfig, []);

    expect(migrated.talk).toMatchObject({
      agentId: "ops",
      provider: "demo",
      providers: { demo: { voiceId: "demo-voice", apiKey: legacyRef } },
    });
  });
});
