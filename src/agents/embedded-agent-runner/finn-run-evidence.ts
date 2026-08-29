import type { AssistantMessage } from "../../llm/types.js";
import {
  createFinnRequestEvidenceCollector,
  type FinnRequestEvidenceCollector,
} from "../finn-request-id-evidence.js";

export function createRunFinnRequestEvidence(): FinnRequestEvidenceCollector {
  return createFinnRequestEvidenceCollector();
}

export function resolveFinnRequestEvidenceFromCollector(
  collector: FinnRequestEvidenceCollector,
): Partial<Pick<AssistantMessage, "finnRequestIds" | "finnRequestIdEvidenceComplete">> {
  return collector.requestIds.length > 0
    ? {
        finnRequestIds: [...collector.requestIds],
        finnRequestIdEvidenceComplete: collector.complete,
      }
    : {};
}

export function resolveFinnRequestEvidenceMeta(
  assistant: AssistantMessage | undefined,
): Partial<Pick<AssistantMessage, "finnRequestIds" | "finnRequestIdEvidenceComplete">> {
  return Array.isArray(assistant?.finnRequestIds)
    ? {
        finnRequestIds: [...assistant.finnRequestIds],
        finnRequestIdEvidenceComplete: assistant.finnRequestIdEvidenceComplete === true,
      }
    : {};
}
