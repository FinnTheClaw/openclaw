/** Keeps production scope selection outside the host's bounded orchestration file. */
export function createGovernorAgentLoopScopeResolver<Host, Input, Scope>(params: {
  active: () => Host | undefined;
  admitted: (host: Host) => boolean;
  selected: (host: Host, input: Input) => boolean;
  createScope: (host: Host, input: Input) => Scope | undefined;
  isShadow: (host: Host) => boolean;
}): (input: Input) => Scope | undefined {
  return (input) => {
    const host = params.active();
    if (!host || !params.admitted(host) || !params.selected(host, input)) {
      return undefined;
    }
    try {
      return params.createScope(host, input);
    } catch (error) {
      if (params.isShadow(host)) {
        return undefined;
      }
      throw error;
    }
  };
}
