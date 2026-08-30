import path from "node:path";
import { fencePriorGatewayAcceptanceReceipts } from "../agents/subagent-gateway-acceptance-receipt-recovery.sqlite.js";
import {
  clearGatewayAcceptanceReceiptSigner,
  installGatewayAcceptanceReceiptSigner,
} from "../agents/subagent-gateway-acceptance-receipt-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { prepareBehaviorGovernorModuleHostSnapshot } from "../secrets/runtime-module-host.js";
import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import { createGovernorAgentLoopScopeProvider } from "../security/governor-agent-loop-scope-provider.js";
import { createGovernorHostRuntimeIfEnabled } from "../security/governor-host-bootstrap.js";
import type {
  GatewayBehaviorGovernorModuleAgentLoop,
  GatewayBehaviorGovernorModuleRunInput,
} from "./behavior-governor-module-agent-loop.js";
import {
  loadGatewayBehaviorGovernorModuleHostDescriptor,
  type GatewayBehaviorGovernorModuleHostDescriptor,
} from "./behavior-governor-module-host-descriptor.js";
import {
  createGatewayBehaviorGovernorModuleRunBindingAuthority,
  type GatewayBehaviorGovernorModuleRunBinding,
  type GatewayBehaviorGovernorModuleRunBindingInput,
  type GatewayBehaviorGovernorModuleRunBindingToken,
} from "./behavior-governor-module-run-bindings.js";

export type GatewayBehaviorGovernorModuleScopeProvider = Readonly<{
  resolveRunScope: (
    input: GatewayBehaviorGovernorModuleRunInput,
    token: GatewayBehaviorGovernorModuleRunBindingToken,
  ) => ReturnType<GatewayBehaviorGovernorModuleAgentLoop["resolveRunScope"]>;
  freeze: () => void;
  close: () => void;
}>;

export type GatewayBehaviorGovernorModuleHostCapability = Readonly<{
  agentLoop: Readonly<{
    createScopeProvider: (
      config: GovernorAgentLoopConfiguration,
    ) => GatewayBehaviorGovernorModuleScopeProvider;
    createRunBinding: (
      input: GatewayBehaviorGovernorModuleRunBindingInput,
    ) => GatewayBehaviorGovernorModuleRunBinding;
  }>;
}>;

export type GatewayBehaviorGovernorModuleHostLeaseCapability = Readonly<{
  forActivation: (
    activation: GatewayBehaviorGovernorModuleRunInput["activation"],
  ) => GatewayBehaviorGovernorModuleHostCapability;
}>;

export type GatewayBehaviorGovernorModuleHostLease = Readonly<{
  capability: GatewayBehaviorGovernorModuleHostLeaseCapability;
  freeze: () => void | Promise<void>;
  close: () => void | Promise<void>;
}>;

export type GatewayBehaviorGovernorModuleHostProvider = Readonly<{
  acquire: (params: {
    gatewayConfig: OpenClawConfig;
  }) => Promise<GatewayBehaviorGovernorModuleHostLease>;
}>;

function secretEnvironment(
  snapshot: Awaited<ReturnType<typeof prepareBehaviorGovernorModuleHostSnapshot>>,
  stateDir: string,
): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: snapshot.secrets.identityHmacKey,
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: snapshot.secrets.evidenceAdmissionKey,
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: snapshot.secrets.evidenceAdmissionKeyId,
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: snapshot.secrets.receiptSigningKey,
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: snapshot.secrets.ledgerSigningKey,
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: snapshot.secrets.deploymentIdentity,
  };
}

async function acquireDescriptorHost(
  descriptor: GatewayBehaviorGovernorModuleHostDescriptor,
  gatewayConfig: OpenClawConfig,
): Promise<GatewayBehaviorGovernorModuleHostLease> {
  const snapshot = await prepareBehaviorGovernorModuleHostSnapshot(descriptor.secretRefs);
  const stateDir = path.join(snapshot.stateDir, "governor");
  const runtime = createGovernorHostRuntimeIfEnabled({
    enabled: true,
    env: secretEnvironment(snapshot, stateDir),
    stateDir,
    capabilities: descriptor.capabilities,
    integrations: {
      ...descriptor.integrations,
      channelConfig: gatewayConfig,
    },
  });
  if (!runtime) {
    throw new Error("GOVERNOR_MODULE_HOST_RUNTIME_NOT_CREATED");
  }
  const children = new Set<GatewayBehaviorGovernorModuleScopeProvider>();
  const authorities = new Set<
    ReturnType<typeof createGatewayBehaviorGovernorModuleRunBindingAuthority>
  >();
  let frozen = false;
  let closed = false;
  try {
    installGatewayAcceptanceReceiptSigner({
      signingKey: snapshot.secrets.receiptSigningKey,
      generation: snapshot.generation,
    });
    fencePriorGatewayAcceptanceReceipts(getAgentEventLifecycleGeneration());
  } catch (error) {
    runtime.close();
    clearGatewayAcceptanceReceiptSigner();
    throw error;
  }
  const createOwnedProvider = (config: GovernorAgentLoopConfiguration) =>
    createGovernorAgentLoopScopeProvider({
      controller: runtime.adapter.controller,
      submitObservedReceipt: runtime.owners.evidence.submitObservedReceipt,
      capabilities: descriptor.capabilities,
      config,
    });
  const capability: GatewayBehaviorGovernorModuleHostLeaseCapability = Object.freeze({
    forActivation(activation) {
      if (frozen || closed) {
        throw new Error("GOVERNOR_MODULE_HOST_ADMISSION_FROZEN");
      }
      const authority = createGatewayBehaviorGovernorModuleRunBindingAuthority({ activation });
      authorities.add(authority);
      return Object.freeze({
        agentLoop: Object.freeze({
          createScopeProvider(config: GovernorAgentLoopConfiguration) {
            if (frozen || closed) {
              throw new Error("GOVERNOR_MODULE_HOST_ADMISSION_FROZEN");
            }
            const owned = createOwnedProvider(config);
            let childClosed = false;
            const child: GatewayBehaviorGovernorModuleScopeProvider = Object.freeze({
              resolveRunScope(
                input: GatewayBehaviorGovernorModuleRunInput,
                token: GatewayBehaviorGovernorModuleRunBindingToken,
              ) {
                if (
                  input.activation.id !== activation.id ||
                  input.activation.version !== activation.version ||
                  input.activation.mode !== activation.mode ||
                  input.activation.mode !== config.mode
                ) {
                  throw new Error("GOVERNOR_MODULE_HOST_MODE_MISMATCH");
                }
                return authority.resolveRunScope(input, token, owned);
              },
              freeze: owned.freeze,
              close() {
                if (childClosed) {
                  return;
                }
                owned.close();
                childClosed = true;
                children.delete(child);
              },
            });
            children.add(child);
            return child;
          },
          createRunBinding: authority.createRunBinding,
        }),
      });
    },
  });
  return Object.freeze({
    capability,
    freeze() {
      if (frozen) {
        return;
      }
      frozen = true;
      for (const authority of authorities) {
        authority.freeze();
      }
      for (const child of children) {
        child.freeze();
      }
      runtime.freeze();
    },
    close() {
      if (closed) {
        return;
      }
      frozen = true;
      const errors: unknown[] = [];
      for (const authority of [...authorities].toReversed()) {
        try {
          authority.close();
          authorities.delete(authority);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const child of [...children].toReversed()) {
        try {
          child.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (children.size === 0 && authorities.size === 0) {
        try {
          runtime.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0 || children.size > 0 || authorities.size > 0) {
        throw new AggregateError(errors, "GOVERNOR_MODULE_HOST_CLOSE_FAILED");
      }
      clearGatewayAcceptanceReceiptSigner();
      closed = true;
    },
  });
}

/** Creates a lazy provider; descriptor and secret I/O begins only in acquire(). */
export function createGatewayBehaviorGovernorModuleHostProvider(
  descriptorPath: string,
): GatewayBehaviorGovernorModuleHostProvider {
  let acquired = false;
  return Object.freeze({
    async acquire({ gatewayConfig }) {
      if (acquired) {
        throw new Error("GOVERNOR_MODULE_HOST_ALREADY_ACQUIRED");
      }
      acquired = true;
      try {
        const descriptor = await loadGatewayBehaviorGovernorModuleHostDescriptor(descriptorPath);
        return await acquireDescriptorHost(descriptor, gatewayConfig);
      } catch (error) {
        acquired = false;
        throw error;
      }
    },
  });
}
