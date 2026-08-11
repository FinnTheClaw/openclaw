import { describe, expect, it } from "vitest";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import {
  GOVERNOR_DELIVERY_BUILD_MANIFEST,
  GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST,
} from "./governor-host-delivery-build-manifest.generated.js";
import {
  governorDeliveryArtifactDigest,
  governorDeliveryBuildManifestDigest,
} from "./governor-host-delivery-build-manifest.js";

describe("governor delivery build manifest", () => {
  it("covers each compiled effect boundary with a reproducible root digest", () => {
    expect(governorDeliveryBuildManifestDigest()).toBe(GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST);
    for (const required of [
      "src/security/governor-host-canary-sink.ts",
      "src/security/governor-host-channel-delivery.ts",
      "src/infra/outbound/message.ts",
      "src/infra/outbound/message.gateway.runtime.ts",
      "src/channels/plugins/index.ts",
      "src/plugins/runtime.ts",
      "extensions/signal/src/send.runtime.ts",
      "extensions/imessage/src/send.ts",
      "pnpm-lock.yaml",
    ]) {
      expect(governorDeliveryArtifactDigest(required), required).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it.each([
    "src/security/governor-host-channel-delivery.ts",
    "src/infra/outbound/message.ts",
    "extensions/signal/src/send.runtime.ts",
    "extensions/imessage/src/send.ts",
  ])("invalidates certification when %s changes", (changedPath) => {
    const artifacts = GOVERNOR_DELIVERY_BUILD_MANIFEST.artifacts as readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
    const changed = {
      version: GOVERNOR_DELIVERY_BUILD_MANIFEST.version,
      entrypoints: GOVERNOR_DELIVERY_BUILD_MANIFEST.entrypoints,
      dynamicRoots: GOVERNOR_DELIVERY_BUILD_MANIFEST.dynamicRoots,
      artifacts: artifacts.map((entry) =>
        entry.path === changedPath ? { path: entry.path, sha256: "0".repeat(64) } : entry,
      ),
    } as unknown as GovernorJsonValue;
    expect(governorDigest(changed)).not.toBe(GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST);
  });
});
