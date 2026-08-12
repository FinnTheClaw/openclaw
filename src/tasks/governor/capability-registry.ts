import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
// Authorizes versioned capabilities and binds privileged actions to current approvals.
import type { GovernorActionProposal } from "./tool-outcome.js";
import {
  opaqueGovernorReference,
  type GovernorIdentityContext,
  type GovernorTaskProjection,
} from "./types.js";

export type GovernorCapabilityDefinition = {
  capability: string;
  version: string;
  sourceRank: GovernorActionProposal["sourceRank"];
  mutating: boolean;
  canonicalTargetPrefixes: readonly string[];
  requiresApproval: boolean;
};

const SOURCE_RANK_PRIORITY: Record<GovernorActionProposal["sourceRank"], number> = {
  structured_exact: 0,
  scoped_index: 1,
  targeted_search: 2,
  broad_scan: 3,
};

export type GovernorActionRejectionCode =
  | "unknown_capability"
  | "capability_version_mismatch"
  | "source_rank_mismatch"
  | "mutation_mode_mismatch"
  | "target_not_supported"
  | "read_only_discovery_denied"
  | "mutation_capability_denied"
  | "mutation_target_denied"
  | "approval_required"
  | "approval_stale"
  | "approval_revoked";

export class GovernorActionRejectedError extends Error {
  constructor(readonly code: GovernorActionRejectionCode) {
    super(`Governor action rejected: ${code}`);
  }
}

export class GovernorCapabilityRegistry {
  readonly #definitions: ReadonlyMap<string, GovernorCapabilityDefinition>;

  constructor(definitions: readonly GovernorCapabilityDefinition[]) {
    const entries = definitions.map((definition) => {
      const snapshot = Object.freeze({
        ...definition,
        canonicalTargetPrefixes: Object.freeze([...definition.canonicalTargetPrefixes]),
      });
      return [snapshot.capability, snapshot] as const;
    });
    if (new Set(entries.map(([capability]) => capability)).size !== entries.length) {
      throw new Error("Governor capability registry contains duplicate capability IDs");
    }
    this.#definitions = new Map(entries);
  }

  workClassificationPolicy(capabilities: readonly string[]): {
    effectful: boolean;
    requiresApproval: boolean;
    unknownCapability: boolean;
    digest: string;
  } {
    const definitions = capabilities.map((capability) => this.#definitions.get(capability));
    const unknownCapability = definitions.some((definition) => !definition);
    const policy = [...this.#definitions.values()].toSorted((left, right) =>
      left.capability.localeCompare(right.capability),
    );
    return {
      effectful: capabilities.length > 0,
      requiresApproval: definitions.some((definition) => definition?.requiresApproval === true),
      unknownCapability,
      digest: governorDigest(policy as unknown as GovernorJsonValue),
    };
  }

  preferredFor(params: {
    mutating: boolean;
    canonicalTarget: string;
  }): GovernorCapabilityDefinition[] {
    return [...this.#definitions.values()]
      .filter(
        (definition) =>
          definition.mutating === params.mutating &&
          definition.canonicalTargetPrefixes.some((prefix) =>
            params.canonicalTarget.startsWith(prefix),
          ),
      )
      .toSorted(
        (left, right) =>
          SOURCE_RANK_PRIORITY[left.sourceRank] - SOURCE_RANK_PRIORITY[right.sourceRank] ||
          left.capability.localeCompare(right.capability),
      );
  }

  requiresApproval(capability: string): boolean {
    return this.#definitions.get(capability)?.requiresApproval === true;
  }

  definition(capability: string): GovernorCapabilityDefinition | undefined {
    return this.#definitions.get(capability);
  }

  approvalPolicy(proposal: GovernorActionProposal): {
    required: boolean;
    digest: string;
  } {
    const definition = this.#definitions.get(proposal.capability);
    if (!definition) {
      throw new GovernorActionRejectedError("unknown_capability");
    }
    return {
      required: definition.mutating && definition.requiresApproval,
      digest: governorDigest({
        capability: definition.capability,
        version: definition.version,
        sourceRank: definition.sourceRank,
        mutating: definition.mutating,
        canonicalTargetPrefixes: definition.canonicalTargetPrefixes,
        requiresApproval: definition.requiresApproval,
      } as unknown as GovernorJsonValue),
    };
  }

  assertAuthorized(task: GovernorTaskProjection, proposal: GovernorActionProposal): void {
    const definition = this.#definitions.get(proposal.capability);
    if (!definition) {
      throw new GovernorActionRejectedError("unknown_capability");
    }
    if (definition.version !== proposal.capabilityVersion) {
      throw new GovernorActionRejectedError("capability_version_mismatch");
    }
    if (definition.sourceRank !== proposal.sourceRank) {
      throw new GovernorActionRejectedError("source_rank_mismatch");
    }
    if (definition.mutating !== proposal.mutating) {
      throw new GovernorActionRejectedError("mutation_mode_mismatch");
    }
    if (
      !definition.canonicalTargetPrefixes.some((prefix) =>
        proposal.canonicalTarget.startsWith(prefix),
      )
    ) {
      throw new GovernorActionRejectedError("target_not_supported");
    }
    if (!proposal.mutating) {
      if (!task.contract.authority.allowReadOnlyDiscovery) {
        throw new GovernorActionRejectedError("read_only_discovery_denied");
      }
      return;
    }
    if (!task.contract.authority.mutationCapabilities.includes(proposal.capability)) {
      throw new GovernorActionRejectedError("mutation_capability_denied");
    }
    if (!task.contract.authority.canonicalTargets.includes(proposal.canonicalTarget)) {
      throw new GovernorActionRejectedError("mutation_target_denied");
    }
    if (!definition.requiresApproval) {
      return;
    }
    if (!proposal.approvalGrantId) {
      throw new GovernorActionRejectedError("approval_required");
    }
  }

  assertPersistedIntentAuthorized(
    task: GovernorTaskProjection,
    proposal: GovernorActionProposal,
    identity: GovernorIdentityContext,
  ): void {
    const definition = this.#definitions.get(proposal.capability);
    if (!definition) {
      throw new GovernorActionRejectedError("unknown_capability");
    }
    if (definition.version !== proposal.capabilityVersion) {
      throw new GovernorActionRejectedError("capability_version_mismatch");
    }
    if (
      definition.sourceRank !== proposal.sourceRank ||
      definition.mutating !== proposal.mutating
    ) {
      throw new GovernorActionRejectedError("source_rank_mismatch");
    }
    if (!proposal.mutating) {
      if (!task.contract.authority.allowReadOnlyDiscovery) {
        throw new GovernorActionRejectedError("read_only_discovery_denied");
      }
      return;
    }
    if (!task.contract.authority.mutationCapabilities.includes(proposal.capability)) {
      throw new GovernorActionRejectedError("mutation_capability_denied");
    }
    if (
      !task.contract.authority.canonicalTargets.some(
        (target) =>
          opaqueGovernorReference("action-target", target, identity) === proposal.canonicalTarget,
      )
    ) {
      throw new GovernorActionRejectedError("mutation_target_denied");
    }
    if (definition.requiresApproval && !proposal.approvalGrantId) {
      throw new GovernorActionRejectedError("approval_required");
    }
  }
}
