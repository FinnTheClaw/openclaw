import path from "node:path";
import { z } from "zod";

const AbsoluteSocketPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => path.isAbsolute(value), "must be an absolute Unix socket path");

export const SignalFunctionalFinnExternalAuthoritySchema = z
  .object({
    enabled: z.literal(true),
    agentId: z.string().min(1).max(128),
    candidateSocketPath: AbsoluteSocketPathSchema,
    ingressSocketPath: AbsoluteSocketPathSchema,
    timeoutMs: z.number().int().min(100).max(5_000).optional(),
    protectedTransport: z.literal(true),
  })
  .strict();
