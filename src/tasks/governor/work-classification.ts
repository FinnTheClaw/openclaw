// Derives the minimum governed mode from durable contract and host capability policy.
import { canonicalGovernorJson, governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import type { GovernorCapabilityRegistry } from "./capability-registry.js";
import {
  classifyGovernorWork,
  type GovernorWorkDecision,
  type GovernorWorkProfile,
} from "./planning-policy.js";
import type {
  GovernorMode,
  GovernorTaskContract,
  GovernorWorkClassificationBinding,
} from "./types.js";

export type GovernorBoundWorkDecision = GovernorWorkDecision & {
  binding: GovernorWorkClassificationBinding;
};

const WORK_CLASSIFICATION_POLICY = {
  version: 1,
  callerMayOnlyEscalate: true,
  quickRequires: [
    "no_effect",
    "no_external_evidence",
    "no_approval",
    "no_durable_continuation",
    "known_capability_policy",
  ],
} as const;

const WORK_CLASSIFICATION_POLICY_DIGEST = governorDigest(
  WORK_CLASSIFICATION_POLICY as unknown as GovernorJsonValue,
);

const MODE_PROFILES: Record<GovernorMode, GovernorWorkProfile> = {
  QUICK: {
    incident: false,
    effectful: false,
    requiresExternalEvidence: false,
    consequential: false,
    estimatedUsefulActions: 0,
    independentBranches: 0,
  },
  FOCUSED: {
    incident: false,
    effectful: false,
    requiresExternalEvidence: false,
    consequential: true,
    estimatedUsefulActions: 0,
    independentBranches: 0,
  },
  DEEP: {
    incident: false,
    effectful: false,
    requiresExternalEvidence: false,
    consequential: true,
    estimatedUsefulActions: 13,
    independentBranches: 4,
  },
  INCIDENT: {
    incident: true,
    effectful: false,
    requiresExternalEvidence: false,
    consequential: true,
    estimatedUsefulActions: 0,
    independentBranches: 0,
  },
};

function requestedProfile(
  profile: GovernorWorkProfile | undefined,
  mode: GovernorMode | undefined,
) {
  const modeProfile = mode ? MODE_PROFILES[mode] : MODE_PROFILES.QUICK;
  if (!profile) {
    return modeProfile;
  }
  return {
    incident: profile.incident || modeProfile.incident,
    effectful: profile.effectful || modeProfile.effectful,
    requiresExternalEvidence:
      profile.requiresExternalEvidence || modeProfile.requiresExternalEvidence,
    consequential: profile.consequential || modeProfile.consequential,
    estimatedUsefulActions: Math.max(
      profile.estimatedUsefulActions,
      modeProfile.estimatedUsefulActions,
    ),
    independentBranches: Math.max(profile.independentBranches, modeProfile.independentBranches),
  };
}

export function classifyGovernorRequest(params: {
  contract: GovernorTaskContract;
  capabilities: GovernorCapabilityRegistry;
  profile?: GovernorWorkProfile;
  requestedMode?: GovernorMode;
}): GovernorBoundWorkDecision {
  const requested = requestedProfile(params.profile, params.requestedMode);
  const capabilityPolicy = params.capabilities.workClassificationPolicy(
    params.contract.authority.mutationCapabilities,
  );
  const requiresExternalEvidence =
    params.contract.authority.allowReadOnlyDiscovery &&
    (params.contract.unknowns.length > 0 || params.contract.authority.canonicalTargets.length > 0);
  const requiresDurableContinuation =
    params.contract.completionCriteria.some((criterion) => criterion.mandatory) ||
    params.contract.correctsEventId !== undefined ||
    params.contract.supersedesEventId !== undefined;
  const effectiveProfile: GovernorWorkProfile = {
    incident: requested.incident,
    effectful: requested.effectful || capabilityPolicy.effectful,
    requiresExternalEvidence: requested.requiresExternalEvidence || requiresExternalEvidence,
    consequential:
      requested.consequential ||
      requiresDurableContinuation ||
      capabilityPolicy.requiresApproval ||
      capabilityPolicy.unknownCapability,
    estimatedUsefulActions: requested.estimatedUsefulActions,
    independentBranches: requested.independentBranches,
  };
  const decision = classifyGovernorWork(effectiveProfile);
  const contractDigest = governorDigest(params.contract as unknown as GovernorJsonValue);
  const requestProfileDigest = governorDigest(effectiveProfile as unknown as GovernorJsonValue);
  const decisionDigest = governorDigest({
    policyVersion: WORK_CLASSIFICATION_POLICY.version,
    policyDigest: WORK_CLASSIFICATION_POLICY_DIGEST,
    contractDigest,
    capabilityPolicyDigest: capabilityPolicy.digest,
    requestProfileDigest,
    mode: decision.mode,
    requiresContract: decision.requiresContract,
    requiresPlan: decision.requiresPlan,
    toolPolicy: decision.toolPolicy,
  });
  return {
    ...decision,
    binding: {
      policyVersion: WORK_CLASSIFICATION_POLICY.version,
      policyDigest: WORK_CLASSIFICATION_POLICY_DIGEST,
      contractDigest,
      capabilityPolicyDigest: capabilityPolicy.digest,
      profile: effectiveProfile,
      requestProfileDigest,
      decisionDigest,
      toolPolicy: decision.toolPolicy,
    },
  };
}

export function assertGovernorTaskClassification(
  task: import("./types.js").GovernorTaskProjection,
  capabilities: GovernorCapabilityRegistry,
): void {
  const binding = task.classification;
  if (!binding) {
    throw new Error("GOVERNOR_WORK_CLASSIFICATION_REQUIRED");
  }
  const expected = classifyGovernorRequest({
    contract: task.contract,
    capabilities,
    profile: binding.profile,
  });
  if (
    canonicalGovernorJson(binding as unknown as GovernorJsonValue) !==
      canonicalGovernorJson(expected.binding as unknown as GovernorJsonValue) ||
    task.mode !== expected.mode
  ) {
    throw new Error("GOVERNOR_WORK_CLASSIFICATION_INVALID");
  }
}
