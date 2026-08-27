import type { SecretRef } from "./types.secrets.js";

export type BehaviorGovernorCriterion = Readonly<{
  criterionId: string;
  description: string;
  dependsOnCriteria?: readonly string[];
}>;

export type BehaviorGovernorToolBinding = Readonly<{
  toolName: string;
  capability: string;
  canonicalTarget: string;
  criterionId?: string;
  auxiliary?: boolean;
  criterionArgument?: string;
  criteriaByValue?: Readonly<Record<string, string>>;
  approvalGrantArgument?: string;
  implementationId: string;
}>;

export type BehaviorGovernorAgentLoopConfig = Readonly<{
  scopes: readonly Readonly<{ sessionKey: string; agentId?: string }>[];
  criteria: readonly BehaviorGovernorCriterion[];
  toolBindings: readonly BehaviorGovernorToolBinding[];
  maxTurns: number;
  expectedAssistantTextDigest?: string;
}>;

export type BehaviorGovernorSecretRefs = Readonly<{
  identityHmacKey: SecretRef;
  evidenceAdmissionKey: SecretRef;
  receiptSigningKey: SecretRef;
  ledgerSigningKey: SecretRef;
  deploymentIdentity: SecretRef;
  evidenceAdmissionKeyId?: string;
}>;

export type BehaviorGovernorModuleSelection = Readonly<{
  id: string;
  mode: "shadow" | "enforce";
  version: string;
}>;

export type BehaviorGovernorConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      mode: "shadow" | "enforce";
      secretRefs: BehaviorGovernorSecretRefs;
      agentLoop: BehaviorGovernorAgentLoopConfig;
    }>
  | Readonly<{
      modules: readonly BehaviorGovernorModuleSelection[];
    }>;
