import { describe, expect, it } from "vitest";
import { restoreCurrentPnpmLockedPackages } from "../../scripts/generate-npm-shrinkwrap.mjs";
import {
  changesShrinkwrapOutputLogic,
  pnpmResolutionTopology,
  shrinkwrapLeaves,
} from "../../scripts/npm-shrinkwrap-provenance.mjs";

describe("npm-shrinkwrap provenance", () => {
  it("does not preserve a stale leaf when the pnpm lock contains old and new versions", () => {
    const generated = {
      packages: {
        "": { dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.2.0" },
      },
    };
    const current = {
      packages: {
        "": { dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.1.0" },
      },
    };
    expect(
      restoreCurrentPnpmLockedPackages(generated, current, new Set(["foo@1.1.0", "foo@1.2.0"])),
    ).toEqual(generated);
  });

  it("requires an explicit unchanged topology proof to retain a full current graph", () => {
    const generated = {
      packages: {
        "": { dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.2.0" },
        "node_modules/foo/node_modules/bar": { version: "2.0.0" },
      },
    };
    const current = {
      packages: {
        "": { dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.1.0" },
        "node_modules/foo/node_modules/bar": { version: "2.0.0" },
      },
    };
    const lock = new Set(["foo@1.1.0", "foo@1.2.0", "bar@2.0.0"]);
    expect(restoreCurrentPnpmLockedPackages(generated, current, lock)).toEqual(generated);
    expect(
      restoreCurrentPnpmLockedPackages(generated, current, lock, {
        preserveCurrentResolvedGraph: true,
      }),
    ).toEqual({
      packages: {
        "": generated.packages[""],
        "node_modules/foo": current.packages["node_modules/foo"],
        "node_modules/foo/node_modules/bar": current.packages["node_modules/foo/node_modules/bar"],
      },
    });
  });

  it("changes the fingerprint for a reachable lock edge but not an unreachable entry", () => {
    const baseline = {
      importers: { "extensions/example": { dependencies: { foo: { version: "1.1.0" } } } },
      packages: {
        "foo@1.1.0": { resolution: { integrity: "foo" } },
        "bar@2.0.0": { resolution: { integrity: "bar-two" } },
      },
      snapshots: { "foo@1.1.0": { dependencies: { bar: "2.0.0" } }, "bar@2.0.0": {} },
    };
    const changedReachable = {
      ...baseline,
      packages: { ...baseline.packages, "bar@3.0.0": { resolution: { integrity: "bar-three" } } },
      snapshots: {
        ...baseline.snapshots,
        "foo@1.1.0": { dependencies: { bar: "3.0.0" } },
        "bar@3.0.0": {},
      },
    };
    const changedUnreachable = {
      ...baseline,
      packages: { ...baseline.packages, "other@9.0.0": { resolution: { integrity: "other" } } },
      snapshots: { ...baseline.snapshots, "other@9.0.0": {} },
    };
    const fingerprint = pnpmResolutionTopology(baseline, "extensions/example");
    expect(fingerprint).not.toBe(pnpmResolutionTopology(changedReachable, "extensions/example"));
    expect(fingerprint).toBe(pnpmResolutionTopology(changedUnreachable, "extensions/example"));
  });

  it("compares leaf provenance independently of mutable root metadata", () => {
    const source = JSON.stringify({
      packages: {
        "": { version: "1.0.0", dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.1.0", integrity: "foo-one" },
      },
    });
    const metadataOnly = JSON.stringify({
      packages: {
        "": { version: "1.0.1", dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.1.0", integrity: "foo-one" },
      },
    });
    const changedLeaf = JSON.stringify({
      packages: {
        "": { version: "1.0.1", dependencies: { foo: "^1.0.0" } },
        "node_modules/foo": { version: "1.2.0", integrity: "foo-two" },
      },
    });
    expect(shrinkwrapLeaves(metadataOnly)).toEqual(shrinkwrapLeaves(source));
    expect(shrinkwrapLeaves(changedLeaf)).not.toEqual(shrinkwrapLeaves(source));
  });

  it("treats every output-logic module as a provenance boundary", () => {
    expect(
      changesShrinkwrapOutputLogic([
        "scripts/npm-shrinkwrap-provenance.mjs",
        "extensions/memory-lancedb/npm-shrinkwrap.json",
      ]),
    ).toBe(true);
    expect(changesShrinkwrapOutputLogic(["scripts/npm-runner.mjs"])).toBe(true);
    expect(changesShrinkwrapOutputLogic(["scripts/windows-cmd-helpers.mjs"])).toBe(true);
    expect(changesShrinkwrapOutputLogic(["scripts/changed-lanes.mjs"])).toBe(false);
  });
});
