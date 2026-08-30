import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BehaviorGovernorSecretRefs } from "../config/types.behavior-governor.js";
import { SecretRefSchema } from "../config/zod-schema.core.js";
import type { GovernorHostIntegrationConfiguration } from "../security/governor-host-bootstrap.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";

export const BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA =
  "openclaw.behavior-governor-module-host/v1" as const;
export const BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER =
  "behavior-governor-module-host" as const;
export const BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE =
  "behavior-governor-host-secrets-v1.json" as const;

const ClosedSecretRefSchema = (id: string) =>
  SecretRefSchema.refine(
    (ref) =>
      ref.source === "file" &&
      ref.provider === BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER &&
      ref.id === id,
    "module host secret reference is not a closed managed reference",
  );

const CapabilitySchema = z
  .object({
    capability: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(256),
    sourceRank: z.enum(["structured_exact", "scoped_index", "targeted_search", "broad_scan"]),
    mutating: z.boolean(),
    canonicalTargetPrefixes: z.array(z.string().trim().min(1).max(1024)).min(1).max(256),
    requiresApproval: z.boolean(),
  })
  .strict();

const OwnerIngressBindingSchema = z
  .object({
    channel: z.enum(["imessage", "signal"]),
    accountId: z.string().trim().min(1).max(256),
    gatewayInstanceId: z.string().trim().min(1).max(256),
    ownerPrincipal: z.string().trim().min(1).max(256),
    actions: z
      .array(z.enum(["approve", "enable", "reinvestigate", "repair", "revoke"]))
      .min(1)
      .max(5),
    scopeKeys: z.array(z.string().trim().min(1).max(256)).min(1).max(256),
  })
  .strict();

const IntegrationsSchema = z
  .object({
    evidenceOwnerId: z.string().trim().min(1).max(256),
    approvalOwnerId: z.string().trim().min(1).max(256),
    deliveryOwnerId: z.string().trim().min(1).max(256),
    ownerIngressOwnerId: z.string().trim().min(1).max(256),
    childOwnerId: z.string().trim().min(1).max(256),
    ownerIngressBindings: z.array(OwnerIngressBindingSchema).min(1).max(256),
    deliveries: z
      .array(
        z
          .object({
            implementationId: z.string().trim().min(1).max(256),
            config: z.json(),
            generation: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

const DescriptorSchema = z
  .object({
    schema: z.literal(BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA),
    secretRefs: z
      .object({
        identityHmacKey: ClosedSecretRefSchema("/identityHmacKey"),
        evidenceAdmissionKey: ClosedSecretRefSchema("/evidenceAdmissionKey"),
        receiptSigningKey: ClosedSecretRefSchema("/receiptSigningKey"),
        ledgerSigningKey: ClosedSecretRefSchema("/ledgerSigningKey"),
        deploymentIdentity: ClosedSecretRefSchema("/deploymentIdentity"),
        evidenceAdmissionKeyId: z.string().trim().min(1).max(256),
      })
      .strict(),
    capabilities: z.array(CapabilitySchema).min(1).max(256),
    integrations: IntegrationsSchema,
  })
  .strict();

export type GatewayBehaviorGovernorModuleHostDescriptor = Readonly<{
  schema: typeof BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA;
  secretRefs: BehaviorGovernorSecretRefs;
  capabilities: readonly GovernorCapabilityDefinition[];
  integrations: Omit<GovernorHostIntegrationConfiguration, "agentLoop" | "channelConfig">;
}>;

export function parseGatewayBehaviorGovernorModuleHostDescriptor(
  input: unknown,
): GatewayBehaviorGovernorModuleHostDescriptor {
  return Object.freeze(
    DescriptorSchema.parse(input),
  ) as GatewayBehaviorGovernorModuleHostDescriptor;
}

export async function loadGatewayBehaviorGovernorModuleHostDescriptor(
  descriptorPath: string,
): Promise<GatewayBehaviorGovernorModuleHostDescriptor> {
  if (!path.isAbsolute(descriptorPath)) {
    throw new Error("GOVERNOR_MODULE_HOST_DESCRIPTOR_PATH_INVALID");
  }
  const handle = await fs.open(descriptorPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      stat.size > 256 * 1024 ||
      (stat.mode & 0o022) !== 0 ||
      (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0)
    ) {
      throw new Error("GOVERNOR_MODULE_HOST_DESCRIPTOR_UNTRUSTED");
    }
    const content = await handle.readFile({ encoding: "utf8" });
    return parseGatewayBehaviorGovernorModuleHostDescriptor(JSON.parse(content));
  } finally {
    await handle.close();
  }
}
