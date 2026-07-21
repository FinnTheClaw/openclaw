// Plugins retain their own per-run idempotency budgets. This outer cap only
// prevents a misbehaving hook runner from requesting unbounded hidden turns.
export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 64;
export const MAX_RECOVERABLE_TOOL_ERROR_CONTINUATIONS = 8;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  recoverableToolErrorContinuationAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    recoverableToolErrorContinuationAttempts: 0,
  };
}
