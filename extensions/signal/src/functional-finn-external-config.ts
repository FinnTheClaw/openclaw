import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSignalAccount } from "./accounts.js";

export type FunctionalFinnExternalAuthorityConfig = {
  enabled: true;
  agentId: string;
  candidateSocketPath: string;
  ingressSocketPath: string;
  timeoutMs: number;
  protectedTransport: true;
};

export function resolveFunctionalFinnExternalAuthority(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): FunctionalFinnExternalAuthorityConfig | undefined {
  const account = resolveSignalAccount(params);
  const value = account.config.functionalFinnExternalAuthority;
  if (!value || value.enabled !== true || value.protectedTransport !== true) {
    return undefined;
  }
  return Object.freeze({
    enabled: true,
    agentId: value.agentId,
    candidateSocketPath: value.candidateSocketPath,
    ingressSocketPath: value.ingressSocketPath,
    timeoutMs: value.timeoutMs ?? 2_000,
    protectedTransport: true,
  });
}

export function assertSignalDirectTransportAllowed(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  operation: string;
}): void {
  if (resolveFunctionalFinnExternalAuthority(params)) {
    throw new Error(
      `Signal ${params.operation} is unavailable: the protected account is owned by external authority`,
    );
  }
}
