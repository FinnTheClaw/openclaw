/** Build-owned delivery artifact identity; caller input cannot select this manifest. */
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import {
  GOVERNOR_DELIVERY_BUILD_MANIFEST,
  GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST,
} from "./governor-host-delivery-build-manifest.generated.js";

export function governorDeliveryBuildManifestDigest(): string {
  const digest = governorDigest(GOVERNOR_DELIVERY_BUILD_MANIFEST as unknown as GovernorJsonValue);
  if (digest !== GOVERNOR_DELIVERY_BUILD_MANIFEST_DIGEST) {
    throw new Error("Governor delivery build manifest integrity check failed");
  }
  return digest;
}

export function governorDeliveryArtifactDigest(relativePath: string): string | null {
  return (
    GOVERNOR_DELIVERY_BUILD_MANIFEST.artifacts.find((entry) => entry.path === relativePath)
      ?.sha256 ?? null
  );
}
