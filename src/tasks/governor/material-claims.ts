// Admits evidence-linked response assertions before a governed completion can use them.
import type { GovernorEvidenceRecord } from "./evidence.js";
import { assertGovernorBoundarySafe } from "./secret-filter.js";
import type { GovernorTaskClaim, GovernorTaskProjection } from "./types.js";

export type GovernorMaterialClaimInput = {
  claimId: string;
  text: string;
  evidenceIds: readonly string[];
};

export type GovernorResponseFraming = "none" | "result" | "summary";

export type GovernorResponseDraft = {
  framing: GovernorResponseFraming;
  materialClaimIds: readonly string[];
};

export function assertGovernorResponseDraft(draft: GovernorResponseDraft): GovernorResponseDraft {
  const safe = assertGovernorBoundarySafe("session", draft) as GovernorResponseDraft;
  if (
    (safe.framing !== "none" && safe.framing !== "result" && safe.framing !== "summary") ||
    !Array.isArray(safe.materialClaimIds) ||
    safe.materialClaimIds.some((claimId) => !claimId.trim())
  ) {
    throw new Error("Governor response draft is invalid");
  }
  return safe;
}

export function createGovernorMaterialClaims(params: {
  task: GovernorTaskProjection;
  evidence: readonly GovernorEvidenceRecord[];
  claims: readonly GovernorMaterialClaimInput[];
  now: number;
}): GovernorTaskClaim[] {
  const currentEvidence = new Map(
    params.evidence
      .filter(
        (item) =>
          item.objectiveRevision === params.task.objectiveRevision &&
          item.planVersion === params.task.planVersion &&
          item.scopeKey === params.task.scopeKey &&
          item.admissibility === "admitted" &&
          item.invalidatedAt === undefined,
      )
      .map((item) => [item.evidenceId, item]),
  );
  const claimedIds = new Set(params.task.claims.map((claim) => claim.claimId));
  const output: GovernorTaskClaim[] = [];
  for (const input of params.claims) {
    const safe = assertGovernorBoundarySafe("session", input) as GovernorMaterialClaimInput;
    if (!safe.claimId.trim() || !safe.text.trim() || safe.evidenceIds.length === 0) {
      throw new Error("Governor material claims require an id, text, and current evidence");
    }
    if (claimedIds.has(safe.claimId)) {
      throw new Error(`Governor material claim already exists: ${safe.claimId}`);
    }
    const evidence = safe.evidenceIds.map((evidenceId) => currentEvidence.get(evidenceId));
    if (evidence.some((item) => !item)) {
      throw new Error(`Governor material claim has unsupported evidence: ${safe.claimId}`);
    }
    claimedIds.add(safe.claimId);
    output.push({
      claimId: safe.claimId,
      kind: "material",
      text: safe.text,
      evidenceIds: [...safe.evidenceIds],
      evidenceDigest: evidence
        .map((item) => item!.evidenceDigest)
        .toSorted()
        .join(":"),
      objectiveRevision: params.task.objectiveRevision,
      planVersion: params.task.planVersion,
      scopeKey: params.task.scopeKey,
      admittedAt: params.now,
    });
  }
  return output;
}

export function renderGovernorResponse(params: {
  task: GovernorTaskProjection;
  draft: GovernorResponseDraft;
}): string {
  const safe = assertGovernorResponseDraft(params.draft);
  const materialClaims = new Map(
    params.task.claims
      .filter(
        (claim) =>
          claim.kind === "material" &&
          claim.objectiveRevision === params.task.objectiveRevision &&
          claim.planVersion === params.task.planVersion &&
          claim.scopeKey === params.task.scopeKey &&
          typeof claim.text === "string",
      )
      .map((claim) => [claim.claimId, claim]),
  );
  const selected = safe.materialClaimIds.map((claimId) => materialClaims.get(claimId));
  if (selected.some((claim) => !claim)) {
    throw new Error("Governor response references an unsupported material claim");
  }
  const prefix =
    safe.framing === "result" ? "Verified result:" : safe.framing === "summary" ? "Summary:" : "";
  return [prefix, ...selected.map((claim) => claim!.text!)].filter(Boolean).join("\n");
}
