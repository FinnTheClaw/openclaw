import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import type { GovernorAgentLoopConfiguration } from "../security/governor-agent-loop-config.js";
import { resolveGovernorAgentLoopRunScope } from "../security/governor-agent-loop-readonly.js";
import { createGovernorAgentLoopTool } from "../security/governor-agent-loop-tools.js";
import { createGovernorHostRuntimeIfEnabled } from "../security/governor-host-bootstrap.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { C03_BEHAVIOR_GOVERNOR_MODULE } from "./behavior-governor-c03-module.js";
import { C03_CANONICAL_OBSERVATION_KEYS } from "./behavior-governor-campaigns/c03-deep-loop-campaign.fixture.js";
import {
  BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA,
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE,
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER,
} from "./behavior-governor-module-host-descriptor.js";
import { createGatewayBehaviorGovernorModuleHostProvider } from "./behavior-governor-module-host.js";
import type { GatewayBehaviorGovernorModuleActivationContext } from "./behavior-governor-module-lifecycle.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "./behavior-governor-module-lifecycle.js";
import { BUILT_IN_BEHAVIOR_GOVERNOR_MODULES } from "./behavior-governor-module-plan.js";

const capabilities = Object.freeze([
  Object.freeze({
    capability: "read",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c03/observations"],
    requiresApproval: false,
  }),
  Object.freeze({
    capability: "exec",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c03/aggregate"],
    requiresApproval: false,
  }),
]);

function run() {
  return Object.freeze({
    runId: "c03-run",
    sessionKey: "c03-session",
    sessionId: "c03-session-id",
    agentId: "c03-agent",
    workspaceId: "c03-workspace",
    channel: "c03-channel",
    accountId: "c03-account",
    principalId: "c03-principal",
    conversationId: "c03-conversation",
    sourceMessageId: "c03-message",
    sourceSequence: 1,
    prompt: "complete C03",
    now: 100,
  });
}

async function c03Config(): Promise<GovernorAgentLoopConfiguration> {
  let captured: GovernorAgentLoopConfiguration | undefined;
  const resolved = Object.freeze({
    taskId: "c03-fixture-task",
    mode: "enforce" as const,
    beforeTool: () => ({ kind: "allow" as const }),
    afterTool: () => undefined,
    afterTurn: () => ({ kind: "complete" as const }),
    interrupt: () => undefined,
    assertTerminal: () => undefined,
    governedTools: () => [],
    dispose: () => undefined,
  });
  const provider = Object.freeze({
    createRunBinding: (input: { plan: unknown; planDigest: string }) =>
      Object.freeze({
        proof: Object.freeze({
          token: Object.freeze({}) as never,
          plan: input.plan as never,
          planDigest: input.planDigest,
        }),
        close() {},
      }),
    resolveRunScope: () => resolved,
    freeze() {},
    close() {},
  });
  const factory = await C03_BEHAVIOR_GOVERNOR_MODULE.load();
  const runtime = await factory({
    id: C03_BEHAVIOR_GOVERNOR_MODULE.id,
    version: C03_BEHAVIOR_GOVERNOR_MODULE.version,
    mode: "enforce",
    host: Object.freeze({
      agentLoop: Object.freeze({
        createScopeProvider(value: GovernorAgentLoopConfiguration) {
          captured = value;
          return provider as never;
        },
      }),
    }),
  } as GatewayBehaviorGovernorModuleActivationContext);
  runtime.agentLoop?.resolveRunScope({
    activation: Object.freeze({
      id: C03_BEHAVIOR_GOVERNOR_MODULE.id,
      version: "v1",
      mode: "enforce",
    }),
    run: run(),
  });
  await runtime.close();
  if (!captured) throw new Error("C03 configuration unavailable");
  return captured;
}

function environment(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_EXPERIMENTAL_BEHAVIOR_GOVERNOR: "1",
    NODE_ENV: "test",
    OPENCLAW_GOVERNOR_IDENTITY_HMAC_KEY: "c03-test-identity-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY: "c03-test-evidence-key",
    OPENCLAW_GOVERNOR_EVIDENCE_ADMISSION_KEY_ID: "c03-evidence-v1",
    OPENCLAW_GOVERNOR_HOST_RECEIPT_HMAC_KEY: "c03-test-receipt-key",
    OPENCLAW_GOVERNOR_HOST_LEDGER_HMAC_KEY: "c03-test-ledger-key",
    OPENCLAW_GOVERNOR_DEPLOYMENT_ID: "c03-test-deployment",
  };
}

function integrations(config: GovernorAgentLoopConfiguration) {
  return {
    evidenceOwnerId: "c03-evidence-owner",
    approvalOwnerId: "c03-approval-owner",
    deliveryOwnerId: "c03-delivery-owner",
    ownerIngressOwnerId: "c03-ingress-owner",
    childOwnerId: "c03-child-owner",
    ownerIngressBindings: [
      {
        channel: "signal" as const,
        accountId: "c03-owner-account",
        gatewayInstanceId: "c03-owner-gateway",
        ownerPrincipal: "c03-owner-principal",
        actions: ["repair" as const],
        scopeKeys: ["c03-owner-scope"],
      },
    ],
    deliveries: [{ implementationId: "synthetic", config: { channel: "c03" }, generation: 0 }],
    agentLoop: Object.freeze({
      ...config,
      expectedAssistantTextDigest: governorDigest("complete"),
    }),
  };
}

const lifecycleSecrets = Object.freeze({
  identityHmacKey: "c03-lifecycle-identity-key",
  evidenceAdmissionKey: "c03-lifecycle-evidence-key",
  receiptSigningKey: "c03-lifecycle-receipt-key",
  ledgerSigningKey: "c03-lifecycle-ledger-key",
  deploymentIdentity: "c03-lifecycle-deployment",
});

async function prepareLifecycleFiles(stateDir: string): Promise<string> {
  const privateDir = path.join(stateDir, "private");
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(privateDir, BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE),
    JSON.stringify(lifecycleSecrets),
    { mode: 0o600 },
  );
  const ref = (id: keyof typeof lifecycleSecrets) => ({
    source: "file" as const,
    provider: BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER,
    id: `/${id}`,
  });
  const descriptorPath = path.join(stateDir, "c03-module-host.json");
  await fs.writeFile(
    descriptorPath,
    JSON.stringify({
      schema: BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA,
      secretRefs: {
        identityHmacKey: ref("identityHmacKey"),
        evidenceAdmissionKey: ref("evidenceAdmissionKey"),
        evidenceAdmissionKeyId: "c03-evidence-v1",
        receiptSigningKey: ref("receiptSigningKey"),
        ledgerSigningKey: ref("ledgerSigningKey"),
        deploymentIdentity: ref("deploymentIdentity"),
      },
      capabilities,
      integrations: {
        evidenceOwnerId: "c03-evidence-owner",
        approvalOwnerId: "c03-approval-owner",
        deliveryOwnerId: "c03-delivery-owner",
        ownerIngressOwnerId: "c03-ingress-owner",
        childOwnerId: "c03-child-owner",
        ownerIngressBindings: integrations(await c03Config()).ownerIngressBindings,
        deliveries: [
          {
            implementationId: "openclaw.canary.disposable.v1",
            config: { mode: "shadow", sinkId: "disposable-v1" },
            generation: 0,
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
  return descriptorPath;
}

function activateSecrets(stateDir: string): void {
  activateSecretsRuntimeSnapshotState({
    snapshot: {
      sourceConfig: {},
      config: {},
      authStores: [],
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    },
    refreshContext: {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      explicitAgentDirs: null,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    },
    refreshHandler: null,
  });
}

async function activateC03Lifecycle(descriptorPath: string, invocationId: string) {
  process.env.INVOCATION_ID = invocationId;
  const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: [C03_BEHAVIOR_GOVERNOR_MODULE],
    hostProvider: createGatewayBehaviorGovernorModuleHostProvider(descriptorPath),
  });
  await lifecycle.apply([{ id: "c03-deep-productive-loop", version: "v1", mode: "enforce" }]);
  return lifecycle;
}

const priorInvocationId = process.env.INVOCATION_ID;

afterEach(() => {
  closeOpenClawStateDatabase();
  clearSecretsRuntimeSnapshot();
  if (priorInvocationId === undefined) delete process.env.INVOCATION_ID;
  else process.env.INVOCATION_ID = priorInvocationId;
});

describe("C03 deep productive loop module", () => {
  it("is compiled but inert without an exact selection", () => {
    expect(BUILT_IN_BEHAVIOR_GOVERNOR_MODULES).toContain(C03_BEHAVIOR_GOVERNOR_MODULE);
    expect(C03_BEHAVIOR_GOVERNOR_MODULE).toMatchObject({
      id: "c03-deep-productive-loop",
      version: "v1",
      supportedModes: ["enforce"],
      qualifiedModes: ["enforce"],
      dependencies: [],
      durableBoundaryIds: [],
    });
  });

  it("binds one trusted sequential twenty-observation cohort and one final aggregate", async () => {
    const config = await c03Config();
    expect(config.criteria.map((criterion) => criterion.criterionId)).toEqual([
      ...C03_CANONICAL_OBSERVATION_KEYS,
      "c03-aggregate",
    ]);
    expect(config.criteria.map((criterion) => criterion.dependsOnCriteria ?? [])).toEqual([
      [],
      ...C03_CANONICAL_OBSERVATION_KEYS.slice(1).map((_, index) => [
        C03_CANONICAL_OBSERVATION_KEYS[index]!,
      ]),
      [C03_CANONICAL_OBSERVATION_KEYS.at(-1)!],
    ]);
    expect(config.toolBindings).toEqual([
      expect.objectContaining({
        toolName: "read",
        implementationId: "installed-tool:read",
        criteriaByValue: Object.fromEntries(
          C03_CANONICAL_OBSERVATION_KEYS.map((key) => [`/case/c03/${key}.txt`, key]),
        ),
      }),
      expect.objectContaining({
        toolName: "exec",
        criterionId: "c03-aggregate",
        implementationId: "installed-tool:exec",
      }),
    ]);
    expect(config.maxTurns).toBe(24);
  });

  it("persists an observed transient failure, requires its same-key retry, rejects an early finish, and admits one final aggregate", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "c03-module-" }, async (state) => {
      const config = await c03Config();
      const runtime = createGovernorHostRuntimeIfEnabled({
        env: environment(),
        stateDir: state.stateDir,
        capabilities,
        integrations: integrations(config),
      })!;
      const scope = resolveGovernorAgentLoopRunScope(run())!;
      const read = createGovernorAgentLoopTool({
        toolName: "read",
        implementationId: "installed-tool:read",
        argumentName: "path",
      });
      const exec = createGovernorAgentLoopTool({
        toolName: "exec",
        implementationId: "installed-tool:exec",
      });
      scope.prepareTools?.([read, exec]);
      let now = 100;
      let call = 0;
      const observe = async (key: string, isError = false) => {
        const decision = scope.beforeTool({
          toolCallId: `c03-read-${++call}`,
          toolName: "read",
          args: { path: `/case/c03/${key}.txt` },
          tool: read,
          now: ++now,
        });
        expect(decision.kind).toBe("allow");
        await scope.afterTool({
          ticket: decision.kind === "allow" ? decision.ticket : undefined,
          toolCallId: `c03-read-${call}`,
          toolName: "read",
          result: isError ? { error: "transient" } : { value: key },
          isError,
          now: ++now,
        });
        return scope.afterTurn({ assistantText: "working", toolCallCount: 1, now: ++now });
      };
      await observe(C03_CANONICAL_OBSERVATION_KEYS[0]!, true);
      expect(
        runtime.adapter.controller.store
          .listEvents(scope.taskId as never)
          .filter((event) => event.eventType === "runtime_replan_requested"),
      ).toHaveLength(1);
      await observe(C03_CANONICAL_OBSERVATION_KEYS[0]!);
      await observe(C03_CANONICAL_OBSERVATION_KEYS[1]!);
      expect(
        scope.afterTurn({ assistantText: "premature", toolCallCount: 0, now: ++now }),
      ).toMatchObject({
        kind: "continue",
      });
      const earlyAggregate = scope.beforeTool({
        toolCallId: "c03-aggregate-early",
        toolName: "exec",
        args: {},
        tool: exec,
        now: ++now,
      });
      expect(earlyAggregate).toMatchObject({ kind: "block" });
      for (const key of C03_CANONICAL_OBSERVATION_KEYS.slice(2)) await observe(key);
      const aggregate = scope.beforeTool({
        toolCallId: "c03-aggregate",
        toolName: "exec",
        args: {},
        tool: exec,
        now: ++now,
      });
      expect(aggregate.kind).toBe("allow");
      await scope.afterTool({
        ticket: aggregate.kind === "allow" ? aggregate.ticket : undefined,
        toolCallId: "c03-aggregate",
        toolName: "exec",
        result: { value: "complete" },
        isError: false,
        now: ++now,
      });
      expect(
        scope.afterTurn({ assistantText: "working", toolCallCount: 1, now: ++now }),
      ).toMatchObject({
        kind: "continue",
      });
      expect(scope.afterTurn({ assistantText: "complete", toolCallCount: 0, now: ++now })).toEqual({
        kind: "complete",
      });
      scope.assertTerminal();
      expect(runtime.adapter.controller.store.listEffects(scope.taskId as never)).toHaveLength(22);
      scope.dispose();
      runtime.close();
    });
  });

  it("rebinds selected C03 state after restart, isolates a new run, and blocks foreign work", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "c03-restart-" }, async (state) => {
      activateSecrets(state.stateDir);
      const descriptorPath = await prepareLifecycleFiles(state.stateDir);
      const read = createGovernorAgentLoopTool({
        toolName: "read",
        implementationId: "installed-tool:read",
        argumentName: "path",
      });
      const exec = createGovernorAgentLoopTool({
        toolName: "exec",
        implementationId: "installed-tool:exec",
      });
      const firstLifecycle = await activateC03Lifecycle(descriptorPath, "c03-restart-a");
      const firstScope = resolveGovernorAgentLoopRunScope(run())!;
      firstScope.prepareTools?.([read, exec]);
      const first = firstScope.beforeTool({
        toolCallId: "c03-restart-observe-1",
        toolName: "read",
        args: { path: "/case/c03/observe-01.txt" },
        tool: read,
        now: 101,
      });
      expect(first.kind).toBe("allow");
      await firstScope.afterTool({
        ticket: first.kind === "allow" ? first.ticket : undefined,
        toolCallId: "c03-restart-observe-1",
        toolName: "read",
        result: { value: "observe-01" },
        isError: false,
        now: 102,
      });
      expect(
        firstScope.afterTurn({ assistantText: "working", toolCallCount: 1, now: 103 }),
      ).toMatchObject({
        kind: "continue",
      });
      const taskId = firstScope.taskId;
      firstScope.dispose();
      await firstLifecycle.close();

      const resumedLifecycle = await activateC03Lifecycle(descriptorPath, "c03-restart-b");
      const resumedScope = resolveGovernorAgentLoopRunScope({
        ...run(),
        sourceSequence: 2,
        now: 200,
      })!;
      resumedScope.prepareTools?.([read, exec]);
      expect(resumedScope.taskId).toBe(taskId);
      expect(
        resumedScope.beforeTool({
          toolCallId: "c03-restart-duplicate",
          toolName: "read",
          args: { path: "/case/c03/observe-01.txt" },
          tool: read,
          now: 201,
        }),
      ).toMatchObject({ kind: "block" });
      const next = resumedScope.beforeTool({
        toolCallId: "c03-restart-observe-2",
        toolName: "read",
        args: { path: "/case/c03/observe-02.txt" },
        tool: read,
        now: 202,
      });
      expect(next.kind).toBe("allow");
      await resumedScope.afterTool({
        ticket: next.kind === "allow" ? next.ticket : undefined,
        toolCallId: "c03-restart-observe-2",
        toolName: "read",
        result: { value: "observe-02" },
        isError: false,
        now: 203,
      });

      expect(() =>
        resolveGovernorAgentLoopRunScope({
          ...run(),
          runId: "c03-foreign-run",
          sourceMessageId: "c03-foreign-message",
        }),
      ).toThrow("GOVERNOR_AGENT_LOOP_STALE_INGRESS");
      const independentScope = resolveGovernorAgentLoopRunScope({
        ...run(),
        runId: "c03-independent-run",
        sessionKey: "c03-independent-session",
        sessionId: "c03-independent-session-id",
        agentId: "c03-independent-agent",
        sourceMessageId: "c03-independent-message",
        sourceSequence: 3,
        now: 204,
      })!;
      independentScope.prepareTools?.([read, exec]);
      expect(independentScope.taskId).not.toBe(taskId);
      const independentFirst = independentScope.beforeTool({
        toolCallId: "c03-independent-observe-1",
        toolName: "read",
        args: { path: "/case/c03/observe-01.txt" },
        tool: read,
        now: 205,
      });
      expect(independentFirst.kind).toBe("allow");
      await independentScope.afterTool({
        ticket: independentFirst.kind === "allow" ? independentFirst.ticket : undefined,
        toolCallId: "c03-independent-observe-1",
        toolName: "read",
        result: { value: "independent observe-01" },
        isError: false,
        now: 206,
      });
      resumedScope.dispose();
      independentScope.dispose();
      await resumedLifecycle.close();
    });
  });
});
