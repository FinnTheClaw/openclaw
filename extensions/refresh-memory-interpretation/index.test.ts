import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("faithful-memory guidance", () => {
  it("contributes only system guidance through the existing prompt hook", () => {
    const on = vi.fn();
    plugin.register({ on } as unknown as OpenClawPluginApi);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0][0]).toBe("before_prompt_build");
    const handler = on.mock.calls[0][1];
    const first = handler({ prompt: "Remember this.", messages: [] }, {});
    const next = handler({ prompt: "Forget that.", messages: [] }, {});
    expect(Object.keys(first)).toEqual(["appendSystemContext"]);
    expect(next).toEqual(first);
    expect(first.appendSystemContext).toContain("Tentative wording in your reply does");
    expect(first.appendSystemContext).toContain(
      "not qualify an unconditional directive saved in a file.",
    );
    expect(first.appendSystemContext).toContain("Preserve temporal qualifiers");
    expect(first.appendSystemContext).toContain("not an indefinite rule");
    expect(first.appendSystemContext).toContain("explicitly ongoing user preference");
    expect(first.appendSystemContext).toContain("missing provenance—not evidence");
    expect(first.appendSystemContext).toContain("save, update, or forget promptly");
    expect(first.appendSystemContext).toContain("preserving stated exceptions");
    expect(first.appendSystemContext).toContain("supersede the conflicting old rule");
  });
});
