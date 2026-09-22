import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("test:voicecall:closedloop", () => {
  it("selects the maintained closed-loop and media stream tests", () => {
    const source = readFileSync("scripts/test-voicecall-closedloop.mts", "utf8");

    expect(source).toContain('bundledPluginFile("voice-call", "src/manager.closed-loop.test.ts")');
    expect(source).toContain('bundledPluginFile("voice-call", "src/media-stream.test.ts")');
    expect(source).not.toContain('bundledPluginFile("voice-call", "src/manager.test.ts")');
    expect(source).not.toContain('"src/plugins/voice-call.plugin.test.ts"');
  });
});
