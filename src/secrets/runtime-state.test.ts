/** Tests secrets runtime state clone isolation and refresh context. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeGovernorSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "./runtime-state.js";

describe("secrets runtime state", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    envSnapshot.restore();
  });

  it("exposes the active config pair for hot paths without requiring the full snapshot", () => {
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { agents: { list: [{ id: "source" }] } },
      config: { agents: { list: [{ id: "runtime" }] } },
      authStores: [],
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };

    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: null,
      refreshHandler: null,
    });

    const configSnapshot = getActiveSecretsRuntimeConfigSnapshot();
    const fullSnapshot = getActiveSecretsRuntimeSnapshot();

    expect(configSnapshot?.config).not.toBe(fullSnapshot?.config);
    expect(configSnapshot?.sourceConfig).not.toBe(fullSnapshot?.sourceConfig);
    expect(configSnapshot?.config).toEqual(snapshot.config);
    expect(configSnapshot?.sourceConfig).toEqual(snapshot.sourceConfig);
  });

  it("returns an isolated narrow governor snapshot for lifecycle consumers", () => {
    const sourceGovernor = {
      enabled: true,
      mode: "shadow",
      secretRefs: {
        identityHmacKey: { source: "env", provider: "default", id: "GOV_IDENTITY" },
        evidenceAdmissionKey: { source: "env", provider: "default", id: "GOV_EVIDENCE" },
        receiptSigningKey: { source: "env", provider: "default", id: "GOV_RECEIPT" },
        ledgerSigningKey: { source: "env", provider: "default", id: "GOV_LEDGER" },
        deploymentIdentity: { source: "env", provider: "default", id: "GOV_DEPLOYMENT" },
      },
      agentLoop: {
        scopes: [{ sessionKey: "fixture" }],
        criteria: [],
        toolBindings: [],
        maxTurns: 3,
      },
    } as const;
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { experimental: { behaviorGovernor: sourceGovernor } },
      config: {
        experimental: {
          behaviorGovernor: {
            ...sourceGovernor,
            secretRefs: {
              identityHmacKey: "identity",
              evidenceAdmissionKey: "evidence",
              receiptSigningKey: "receipt",
              ledgerSigningKey: "ledger",
              deploymentIdentity: "deployment",
              evidenceAdmissionKeyId: "v1",
            },
          },
        },
      } as unknown as PreparedSecretsRuntimeSnapshot["config"],
      authStores: [],
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };
    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: {
        env: { NODE_ENV: "test", OPENCLAW_STATE_DIR: "fixture-state" },
        explicitAgentDirs: null,
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });

    const first = getActiveSecretsRuntimeGovernorSnapshot();
    expect(first?.config.secretRefs.identityHmacKey).toBe("identity");
    expect(first?.env.OPENCLAW_STATE_DIR).toBe("fixture-state");
    (
      first as unknown as {
        sourceConfig: { agentLoop: { scopes: Array<{ sessionKey: string }> } };
      }
    ).sourceConfig.agentLoop.scopes[0].sessionKey = "mutated";
    (
      first as { config: { secretRefs: { identityHmacKey: string } } }
    ).config.secretRefs.identityHmacKey = "mutated";
    if (first) {
      first.env.OPENCLAW_STATE_DIR = "mutated";
    }
    const second = getActiveSecretsRuntimeGovernorSnapshot();
    expect(second?.sourceConfig.agentLoop.scopes[0]?.sessionKey).toBe("fixture");
    expect(second?.config.secretRefs.identityHmacKey).toBe("identity");
    expect(second?.env.OPENCLAW_STATE_DIR).toBe("fixture-state");
  });

  it("does not expose a legacy secret snapshot for an empty modular plan", () => {
    const snapshot: PreparedSecretsRuntimeSnapshot = {
      sourceConfig: { experimental: { behaviorGovernor: { modules: [] } } },
      config: { experimental: { behaviorGovernor: { modules: [] } } },
      authStores: [],
      warnings: [],
      webTools: {
        search: { providerSource: "none", diagnostics: [] },
        fetch: { providerSource: "none", diagnostics: [] },
        diagnostics: [],
      },
    };
    activateSecretsRuntimeSnapshotState({
      snapshot,
      refreshContext: {
        env: { NODE_ENV: "test" },
        explicitAgentDirs: null,
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      },
      refreshHandler: null,
    });

    expect(getActiveSecretsRuntimeGovernorSnapshot()).toBeNull();
  });
});
