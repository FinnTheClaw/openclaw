import { describe, expect, it } from "vitest";
import { shouldUseLegacyPeerDepsForShrinkwrap } from "../../scripts/generate-npm-shrinkwrap.mjs";

describe("npm-shrinkwrap peer resolution", () => {
  it("uses legacy peer resolution when package peers are optional", () => {
    expect(
      shouldUseLegacyPeerDepsForShrinkwrap({
        dependencies: { zod: "4.4.3" },
        peerDependencies: { openclaw: ">=2026.5.30" },
        peerDependenciesMeta: { openclaw: { optional: true } },
      }),
    ).toBe(true);
  });
});
