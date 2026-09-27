type CloseStage = () => void;

export type GovernorHostRuntimeCloser = Readonly<{
  close: CloseStage;
  closeAsync: () => Promise<void>;
}>;

export function createGovernorHostRuntimeCloser(params: {
  freeze: CloseStage;
  closeAgentLoop: CloseStage;
  flushMemoryBackend: () => Promise<void>;
  closeController: CloseStage;
  closeBindings: CloseStage;
}): GovernorHostRuntimeCloser {
  let closed = false;
  let failure: AggregateError | undefined;

  const throwStoredFailure = (): void => {
    if (failure) {
      throw failure;
    }
  };

  const finish = (errors: unknown[]): void => {
    if (errors.length > 0) {
      failure = new AggregateError(errors, "GOVERNOR_HOST_RUNTIME_CLOSE_FAILED");
      throw failure;
    }
    closed = true;
  };

  const close = (): void => {
    throwStoredFailure();
    if (closed) {
      return;
    }
    const errors: unknown[] = [];
    try {
      params.freeze();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeAgentLoop();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeController();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeBindings();
    } catch (error) {
      errors.push(error);
    }
    finish(errors);
  };

  const closeAsync = async (): Promise<void> => {
    throwStoredFailure();
    if (closed) {
      return;
    }
    const errors: unknown[] = [];
    try {
      params.freeze();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeAgentLoop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await params.flushMemoryBackend();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeController();
    } catch (error) {
      errors.push(error);
    }
    try {
      params.closeBindings();
    } catch (error) {
      errors.push(error);
    }
    finish(errors);
  };

  return Object.freeze({ close, closeAsync });
}
