import type { AssistantMessageDiagnostic } from "./utils/diagnostics.js";

/** Optional provider and runtime metadata attached to an assistant turn. */
export interface AssistantMessageMetadata {
  /** Concrete response model when it differs from the requested model. */
  responseModel?: string;
  /** Provider-specific response identifier when exposed upstream. */
  responseId?: string;
  /** Bounded, ordered, validated evidence returned by the local Finn coordinator. */
  finnRequestIds?: readonly string[];
  /** Observational integrity only; this is not a certification verdict. */
  finnRequestIdEvidenceComplete?: boolean;
  /** Redacted provider/runtime diagnostics for failures and recoveries. */
  diagnostics?: AssistantMessageDiagnostic[];
}
