import { z } from "zod";
import { SecretRefSchema } from "./zod-schema.core.js";

const CriterionSchema = z
  .object({
    criterionId: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(256),
    dependsOnCriteria: z.array(z.string().trim().min(1).max(256)).max(256).optional(),
  })
  .strict();

const ToolBindingSchema = z
  .object({
    toolName: z.string().trim().min(1).max(256),
    capability: z.string().trim().min(1).max(256),
    canonicalTarget: z.string().trim().min(1).max(256),
    criterionId: z.string().trim().min(1).max(256).optional(),
    auxiliary: z.boolean().optional(),
    criterionArgument: z.string().trim().min(1).max(256).optional(),
    criteriaByValue: z
      .record(z.string().trim().min(1).max(256), z.string().trim().min(1).max(256))
      .optional(),
    approvalGrantArgument: z.string().trim().min(1).max(256).optional(),
    implementationId: z.string().trim().min(1).max(256),
  })
  .strict();

const AgentLoopSchema = z
  .object({
    scopes: z
      .array(
        z
          .object({
            sessionKey: z.string().trim().min(1).max(256),
            agentId: z.string().trim().min(1).max(256).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    criteria: z.array(CriterionSchema).max(256),
    toolBindings: z.array(ToolBindingSchema).max(256),
    maxTurns: z.number().int().min(1).max(256),
    expectedAssistantTextDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();

const SecretRefsSchema = z
  .object({
    identityHmacKey: SecretRefSchema,
    evidenceAdmissionKey: SecretRefSchema,
    receiptSigningKey: SecretRefSchema,
    ledgerSigningKey: SecretRefSchema,
    deploymentIdentity: SecretRefSchema,
    evidenceAdmissionKeyId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const BehaviorGovernorConfigSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      mode: z.enum(["shadow", "enforce"]),
      secretRefs: SecretRefsSchema,
      agentLoop: AgentLoopSchema,
    })
    .strict(),
]);
