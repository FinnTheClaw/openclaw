import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { BehaviorGovernorSecretRefs } from "../config/types.behavior-governor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE,
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER,
} from "../gateway/behavior-governor-module-host-descriptor.js";
import { secretRefKey } from "./ref-contract.js";
import { resolveSecretRefValues } from "./resolve.js";
import {
  getActiveSecretsRuntimeGeneration,
  getActiveSecretsRuntimeRefreshContext,
  getActiveSecretsRuntimeSnapshot,
} from "./runtime-state.js";

const SECRET_FIELDS = [
  "identityHmacKey",
  "evidenceAdmissionKey",
  "receiptSigningKey",
  "ledgerSigningKey",
  "deploymentIdentity",
] as const;

export type PreparedBehaviorGovernorModuleHostSnapshot = Readonly<{
  stateDir: string;
  generation: string;
  secrets: Readonly<Record<(typeof SECRET_FIELDS)[number], string>> &
    Readonly<{ evidenceAdmissionKeyId: string }>;
}>;

/** Resolves the managed module-host payload only from the active prepared runtime context. */
export async function prepareBehaviorGovernorModuleHostSnapshot(
  refs: BehaviorGovernorSecretRefs,
): Promise<PreparedBehaviorGovernorModuleHostSnapshot> {
  const active = getActiveSecretsRuntimeSnapshot();
  const refresh = getActiveSecretsRuntimeRefreshContext();
  const generation = getActiveSecretsRuntimeGeneration();
  if (!active || !refresh || !generation) {
    throw new Error("GOVERNOR_MODULE_HOST_SECRET_SNAPSHOT_REQUIRED");
  }
  const stateDir = resolveStateDir(refresh.env);
  const evidenceAdmissionKeyId = refs.evidenceAdmissionKeyId?.trim();
  if (!evidenceAdmissionKeyId) {
    throw new Error("GOVERNOR_MODULE_HOST_SECRET_SNAPSHOT_INVALID");
  }
  const providerPath = path.join(stateDir, "private", BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE);
  const config: OpenClawConfig = {
    ...active.sourceConfig,
    secrets: {
      ...active.sourceConfig.secrets,
      providers: {
        ...active.sourceConfig.secrets?.providers,
        [BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER]: {
          source: "file",
          path: providerPath,
          mode: "json",
        },
      },
    },
  };
  const secretRefs = SECRET_FIELDS.map((field) => refs[field]) as SecretRef[];
  const values = await resolveSecretRefValues(secretRefs, {
    config,
    env: { ...refresh.env },
    ...(refresh.manifestRegistry ? { manifestRegistry: refresh.manifestRegistry } : {}),
  });
  const secrets = Object.fromEntries(
    SECRET_FIELDS.map((field) => {
      const value = values.get(secretRefKey(refs[field]));
      if (typeof value !== "string" || value.trim().length < 16) {
        throw new Error("GOVERNOR_MODULE_HOST_SECRET_SNAPSHOT_INVALID");
      }
      return [field, value] as const;
    }),
  ) as Record<(typeof SECRET_FIELDS)[number], string>;
  return Object.freeze({
    stateDir,
    generation,
    secrets: Object.freeze({
      ...secrets,
      evidenceAdmissionKeyId,
    }),
  });
}
