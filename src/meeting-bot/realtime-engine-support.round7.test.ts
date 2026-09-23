import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { resolveMeetingRealtimeTranscriptionProvider } from "./realtime-engine-support.js";

function provider(id: string, aliases?: string[]): RealtimeTranscriptionProviderPlugin {
  return {
    id,
    label: id,
    aliases,
    isConfigured: () => true,
    createSession: () => ({
      connect: async () => {},
      sendAudio: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };
}

function resolve(
  providers: RealtimeTranscriptionProviderPlugin[],
  selected: { transcriptionProvider?: string; provider?: string } = {},
  configs: Record<string, Record<string, unknown>> = {},
) {
  return resolveMeetingRealtimeTranscriptionProvider({
    config: { realtime: { ...selected, providers: configs } },
    fullConfig: {} as OpenClawConfig,
    providers,
  });
}

describe("round-seven explicit transcription provider selection", () => {
  it("TP01 rejects unknown transcriptionProvider instead of choosing default", () => {
    expect(() => resolve([provider("primary")], { transcriptionProvider: "missing-tp01" })).toThrow(
      'Realtime transcription provider "missing-tp01" is not registered',
    );
  });

  it("TP02 rejects unknown legacy provider instead of choosing default", () => {
    expect(() => resolve([provider("primary")], { provider: "missing-tp02" })).toThrow(
      'Realtime transcription provider "missing-tp02" is not registered',
    );
  });

  it("TP03 selects known exact provider among two", () => {
    expect(
      resolve([provider("first"), provider("second")], { transcriptionProvider: "second" }).provider
        .id,
    ).toBe("second");
  });

  it("TP04 resolves a known alias", () => {
    expect(
      resolve([provider("first"), provider("second", ["alias-second"])], {
        transcriptionProvider: "alias-second",
      }).provider.id,
    ).toBe("second");
  });

  it("TP05 defaults to the only provider when no ID is configured", () => {
    expect(resolve([provider("only")]).provider.id).toBe("only");
  });

  it("TP06 retains first-provider default when no ID is configured", () => {
    expect(resolve([provider("first"), provider("second")]).provider.id).toBe("first");
  });

  it("TP07 rejects a selected provider that is not configured", () => {
    const disabled = { ...provider("disabled"), isConfigured: () => false };
    expect(() =>
      resolve([provider("first"), disabled], { transcriptionProvider: "disabled" }),
    ).toThrow('Realtime transcription provider "disabled" is not configured');
  });

  it("TP08 applies alias-keyed raw config to the selected provider", () => {
    const resolved = resolve(
      [
        {
          ...provider("second", ["alias-second"]),
          resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
        },
      ],
      { transcriptionProvider: "alias-second" },
      { "alias-second": { marker: 8 } },
    );
    expect(resolved.providerConfig).toEqual({ marker: 8, resolved: true });
  });

  it("TP09 reports no registered provider before selection", () => {
    expect(() => resolve([], { transcriptionProvider: "missing-tp09" })).toThrow(
      "No configured realtime transcription provider registered",
    );
  });

  it("TP10 prefers transcriptionProvider over legacy provider", () => {
    expect(
      resolve([provider("legacy"), provider("transcription")], {
        provider: "legacy",
        transcriptionProvider: "transcription",
      }).provider.id,
    ).toBe("transcription");
  });
});
