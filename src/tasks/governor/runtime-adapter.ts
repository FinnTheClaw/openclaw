import {
  isTrustedGovernorOwnerIngressResolver,
  type GovernorTrustedOwnerIngressResolver,
  type HostGovernorOwnerIngressReceiptId,
} from "../../security/governor-host-readonly.js";
import type { GovernorController } from "./controller.js";
import type { GovernorWorkDecision, GovernorWorkProfile } from "./planning-policy.js";
import type { GovernorTaskContract, GovernorTaskProjection, GovernorTaskScope } from "./types.js";
import { classifyGovernorRequest } from "./work-classification.js";

export type GovernorIngressRoute =
  | { kind: "quick"; decision: GovernorWorkDecision }
  | { kind: "governed"; decision: GovernorWorkDecision; task: GovernorTaskProjection };

export class GovernorRuntimeAdapter {
  readonly #ownerIngressResolver?: GovernorTrustedOwnerIngressResolver;

  constructor(
    readonly controller: GovernorController,
    ownerIngressResolver?: GovernorTrustedOwnerIngressResolver,
  ) {
    if (ownerIngressResolver && !isTrustedGovernorOwnerIngressResolver(ownerIngressResolver)) {
      throw new Error("Governor runtime requires a trusted owner-ingress resolver");
    }
    this.#ownerIngressResolver = ownerIngressResolver;
  }

  routeIngress(params: {
    sourceMessageId: string;
    sourceSequence: number;
    scope: GovernorTaskScope;
    profile: GovernorWorkProfile;
    contract: GovernorTaskContract;
    flowId?: string;
    now: number;
  }): GovernorIngressRoute {
    const decision = classifyGovernorRequest({
      profile: params.profile,
      contract: params.contract,
      capabilities: this.controller.capabilities,
    });
    if (decision.mode === "QUICK") {
      return { kind: "quick", decision };
    }
    const ingress = this.controller.ingest({
      sourceMessageId: params.sourceMessageId,
      sourceSequence: params.sourceSequence,
      scope: params.scope,
      profile: params.profile,
      contract: params.contract,
      flowId: params.flowId,
      now: params.now,
    });
    return { kind: "governed", decision, task: ingress.task };
  }

  routeAuthenticatedOwnerIngress(params: {
    receiptId: HostGovernorOwnerIngressReceiptId;
    now: number;
  }): GovernorIngressRoute {
    const resolver = this.#ownerIngressResolver;
    if (!resolver) {
      throw new Error("Governor owner-ingress resolver is unavailable");
    }
    const claim = resolver.claim(params.receiptId, params.now);
    if (!claim) {
      throw new Error("Governor owner-ingress receipt is invalid, expired, or mismatched");
    }
    const receipt = claim.receipt;
    const actionLabel = receipt.action.replaceAll("_", " ");
    const ingress = this.controller.ingest({
      sourceMessageId: receipt.sourceMessageIdentity,
      sourceSequence: receipt.sourceSequence,
      scope: {
        principalId: receipt.ownerPrincipalIdentity,
        channel: receipt.channel,
        accountId: receipt.accountIdentity,
        conversationId: receipt.scopeKey,
        sessionId: receipt.sourceBindingIdentity,
        agentId: "governor-owner-ingress",
        workspaceId: receipt.deploymentIdentity,
      },
      mode: "FOCUSED",
      contract: {
        objective: `Process authenticated owner ${actionLabel} request`,
        constraints: [
          "Use only the action and scope bound by the authenticated owner receipt",
          "Require the ordinary governed approval and verification path before effects",
        ],
        knownFacts: [`Authenticated owner action: ${receipt.action}`],
        unknowns: ["Whether the requested effect is currently authorized and safe"],
        completionCriteria: [
          {
            criterionId: "owner-action-verified",
            description: "The bound owner action is verified or explicitly blocked",
            mandatory: true,
          },
        ],
        authority: {
          allowReadOnlyDiscovery: true,
          mutationCapabilities: [],
          canonicalTargets: [receipt.scopeKey],
        },
      },
      now: params.now,
    });
    if (!resolver.finalize(claim, ingress.task.taskId, params.now)) {
      throw new Error("Governor owner-ingress receipt could not be durably consumed");
    }
    return {
      kind: "governed",
      decision: {
        mode: "FOCUSED",
        requiresContract: true,
        requiresPlan: true,
        toolPolicy: "required",
      },
      task: ingress.task,
    };
  }
}
