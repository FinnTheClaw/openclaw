// Authorizes versioned capabilities and binds privileged actions to current approvals.
import type { GovernorActionProposal } from "./tool-outcome.js";
import type { GovernorTaskProjection } from "./types.js";

export type GovernorCapabilityDefinition = {
  capability: string;
  version: string;
  sourceRank: GovernorActionProposal["sourceRank"];
  mutating: boolean;
  canonicalTargetPrefixes: readonly string[];
  requiresApproval: boolean;
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
    const entries = definitions.map((definition) => [definition.capability, definition] as const);
    if (new Set(entries.map(([capability]) => capability)).size !== entries.length) {
      throw new Error("Governor capability registry contains duplicate capability IDs");
    }
    this.#definitions = new Map(entries);
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
    const approval = proposal.approvalGrant;
    if (!approval) {
      throw new GovernorActionRejectedError("approval_required");
    }
    if (approval.revokedAt !== undefined) {
      throw new GovernorActionRejectedError("approval_revoked");
    }
    if (
      approval.objectiveRevision !== task.objectiveRevision ||
      approval.capabilityVersion !== definition.version ||
      approval.canonicalTarget !== proposal.canonicalTarget
    ) {
      throw new GovernorActionRejectedError("approval_stale");
    }
  }
}
