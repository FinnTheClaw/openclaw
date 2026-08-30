import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizedC02GatewayRegistry } from "../../test/helpers/governor-c02-runtime.js";
import { installGovernorLoopBridge } from "../agents/embedded-agent-runner/governor-loop-bridge.js";
import { resolveEmbeddedAgentStreamFn } from "../agents/embedded-agent-runner/stream-resolution.js";
import { createFinnRequestEvidenceCollector } from "../agents/finn-request-id-evidence.js";
import { isBuiltInProviderTransport } from "../agents/finn-request-id-transport.js";
import { attachModelProviderRequestTransport } from "../agents/provider-request-config.js";
import { registerProviderStreamForModel } from "../agents/provider-stream.js";
import { Agent, type StreamFn } from "../agents/runtime/index.js";
import { C02_BEHAVIOR_GOVERNOR_MODULE } from "../gateway/behavior-governor-c02-module.js";
import {
  BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA,
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE,
  BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER,
} from "../gateway/behavior-governor-module-host-descriptor.js";
import { createGatewayBehaviorGovernorModuleHostProvider } from "../gateway/behavior-governor-module-host.js";
import { createGatewayBehaviorGovernorModuleLifecycle } from "../gateway/behavior-governor-module-lifecycle.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { Model } from "../llm/types.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { governorDigest } from "../tasks/governor/canonical-json.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGovernorAgentLoopRunScope } from "./governor-agent-loop-readonly.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import { CHECKPOINT_PREFIX } from "./governor-c02-runtime-attestation-model.js";

const coordinator = vi.hoisted(() => ({
  replies: [] as Array<{
    requestId: string;
    tool?: { id: string; name: string; arguments: Record<string, string> };
    text?: string;
  }>,
  observedRequestIds: [] as string[],
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...original,
    fetchWithSsrFGuard: async (params: { url: string }) => {
      const reply = coordinator.replies[coordinator.observedRequestIds.length];
      if (!reply) {
        throw new Error("Unexpected coordinator request");
      }
      coordinator.observedRequestIds.push(reply.requestId);
      const delta = reply.tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: reply.tool.id,
                type: "function",
                function: {
                  name: reply.tool.name,
                  arguments: JSON.stringify(reply.tool.arguments),
                },
              },
            ],
          }
        : { role: "assistant", content: reply.text ?? "done" };
      const body = `data: ${JSON.stringify({
        id: `chatcmpl-${reply.requestId}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "moira/brain",
        choices: [{ index: 0, delta, finish_reason: reply.tool ? "tool_calls" : "stop" }],
      })}\n\ndata: [DONE]\n\n`;
      return {
        response: new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-finn-request-id": reply.requestId,
          },
        }),
        finalUrl: params.url,
        release: async () => undefined,
      };
    },
  };
});

const capabilities = [
  {
    capability: "read",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/observations"],
    requiresApproval: false,
  },
  {
    capability: "exec",
    version: "1",
    sourceRank: "structured_exact" as const,
    mutating: false,
    canonicalTargetPrefixes: ["campaign://c02/aggregate"],
    requiresApproval: false,
  },
];

const secrets = {
  identityHmacKey: "c02-identity-key-long",
  evidenceAdmissionKey: "c02-evidence-key-long",
  receiptSigningKey: "c02-receipt-key-long",
  ledgerSigningKey: "c02-ledger-key-long",
  deploymentIdentity: "c02-deployment-long",
};

function run(runId: string): GovernorAgentLoopRunInput {
  return {
    runId,
    sessionKey: "c02-session-key",
    sessionId: "c02-session",
    agentId: "c02-agent",
    workspaceId: "c02-workspace",
    channel: "c02-channel",
    accountId: "c02-account",
    principalId: "c02-principal",
    conversationId: "c02-conversation",
    sourceMessageId: "c02-message-1",
    sourceSequence: 1,
    prompt: "run exact c02 campaign",
    now: 100,
  };
}

async function prepareLifecycleFiles(stateDir: string): Promise<string> {
  const privateDir = path.join(stateDir, "private");
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(privateDir, BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_FILE),
    JSON.stringify(secrets),
    {
      mode: 0o600,
    },
  );
  const ref = (id: keyof typeof secrets) => ({
    source: "file" as const,
    provider: BEHAVIOR_GOVERNOR_MODULE_HOST_SECRET_PROVIDER,
    id: `/${id}`,
  });
  const descriptorPath = path.join(stateDir, "c02-module-host.json");
  await fs.writeFile(
    descriptorPath,
    JSON.stringify({
      schema: BEHAVIOR_GOVERNOR_MODULE_HOST_SCHEMA,
      secretRefs: {
        identityHmacKey: ref("identityHmacKey"),
        evidenceAdmissionKey: ref("evidenceAdmissionKey"),
        receiptSigningKey: ref("receiptSigningKey"),
        ledgerSigningKey: ref("ledgerSigningKey"),
        deploymentIdentity: ref("deploymentIdentity"),
        evidenceAdmissionKeyId: "c02-evidence-v1",
      },
      capabilities,
      integrations: {
        evidenceOwnerId: "c02-evidence-owner",
        approvalOwnerId: "c02-approval-owner",
        deliveryOwnerId: "c02-delivery-owner",
        ownerIngressOwnerId: "c02-ingress-owner",
        childOwnerId: "c02-child-owner",
        ownerIngressBindings: [
          {
            channel: "signal",
            accountId: "c02-owner-account",
            gatewayInstanceId: "c02-owner-gateway",
            ownerPrincipal: "c02-owner-principal",
            actions: ["repair"],
            scopeKeys: ["c02-owner-scope"],
          },
        ],
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

async function activateC02Lifecycle(descriptorPath: string, invocationId: string) {
  process.env.INVOCATION_ID = invocationId;
  const lifecycle = createGatewayBehaviorGovernorModuleLifecycle({
    catalog: [C02_BEHAVIOR_GOVERNOR_MODULE],
    hostProvider: createGatewayBehaviorGovernorModuleHostProvider(descriptorPath),
  });
  await lifecycle.apply([{ id: "c02-simple-efficiency", version: "v1", mode: "enforce" }]);
  return lifecycle;
}

function remoteModel(): Model<"openai-completions"> {
  return attachModelProviderRequestTransport(
    {
      id: "moira/brain",
      name: "Moira brain",
      api: "openai-completions",
      provider: "remote-llm",
      baseUrl: "http://127.0.0.1:8300/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 256,
    },
    { tls: {}, allowPrivateNetwork: true },
  );
}

function productionStream(model: Model<"openai-completions">) {
  const collector = createFinnRequestEvidenceCollector();
  const providerStreamFn = registerProviderStreamForModel({ model, allowRuntimePluginLoad: false });
  if (!providerStreamFn || !isBuiltInProviderTransport(providerStreamFn)) {
    throw new Error("Built-in remote-llm transport unavailable");
  }
  const streamFn: StreamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: undefined,
    providerStreamFn,
    sessionId: "c02-session",
    model,
    resolvedApiKey: "c02-test-key",
    finnRequestEvidence: collector,
  });
  return { collector, streamFn };
}

function lowerCheckpointVersions(stateDir: string): () => void {
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  const database = new DatabaseSync(databasePath);
  const row = database
    .prepare(
      "SELECT checkpoint_id, task_version, checkpoint_json, checkpoint_digest FROM governor_checkpoints",
    )
    .get() as {
    checkpoint_id: string;
    task_version: number;
    checkpoint_json: string;
    checkpoint_digest: string;
  };
  const checkpoint = JSON.parse(row.checkpoint_json) as {
    taskVersion: number;
    verifiedFacts: Array<{ claim: string; evidenceDigest: string }>;
  };
  const bindingFact = checkpoint.verifiedFacts.find((fact) =>
    fact.claim.startsWith(CHECKPOINT_PREFIX),
  );
  if (!bindingFact || checkpoint.taskVersion < 1) {
    throw new Error("C02 checkpoint binding fixture unavailable");
  }
  const binding = JSON.parse(bindingFact.claim.slice(CHECKPOINT_PREFIX.length)) as {
    taskVersion: number;
  };
  checkpoint.taskVersion -= 1;
  binding.taskVersion = checkpoint.taskVersion;
  bindingFact.claim = `${CHECKPOINT_PREFIX}${JSON.stringify(binding)}`;
  bindingFact.evidenceDigest = governorDigest(binding as never);
  database
    .prepare(
      "UPDATE governor_checkpoints SET task_version = ?, checkpoint_json = ?, checkpoint_digest = ? WHERE checkpoint_id = ?",
    )
    .run(
      checkpoint.taskVersion,
      JSON.stringify(checkpoint),
      governorDigest(checkpoint as never),
      row.checkpoint_id,
    );
  database.close();
  return () => {
    const restore = new DatabaseSync(databasePath);
    restore
      .prepare(
        "UPDATE governor_checkpoints SET task_version = ?, checkpoint_json = ?, checkpoint_digest = ? WHERE checkpoint_id = ?",
      )
      .run(row.task_version, row.checkpoint_json, row.checkpoint_digest, row.checkpoint_id);
    restore.close();
  };
}

const priorInvocationId = process.env.INVOCATION_ID;

afterEach(() => {
  closeOpenClawStateDatabase();
  clearSecretsRuntimeSnapshot();
  coordinator.replies = [];
  coordinator.observedRequestIds = [];
  if (priorInvocationId === undefined) {
    delete process.env.INVOCATION_ID;
  } else {
    process.env.INVOCATION_ID = priorInvocationId;
  }
});

describe("C02 production-composed embedded Agent restart", () => {
  it("persists pre-restart evidence and merges only a fresh post-restart Finn collector", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "c02-agent-restart-" },
      async (state) => {
        activateSecrets(state.stateDir);
        const descriptorPath = await prepareLifecycleFiles(state.stateDir);
        coordinator.replies = [
          {
            requestId: "req_c02_pre_1",
            tool: { id: "c02-call-1", name: "read", arguments: { path: "/case/alpha.txt" } },
          },
          {
            requestId: "req_c02_pre_2",
            tool: { id: "c02-call-2", name: "read", arguments: { path: "/case/beta.txt" } },
          },
          {
            requestId: "req_c02_post_1",
            tool: {
              id: "c02-call-3",
              name: "exec",
              arguments: { command: "/usr/bin/python3 -c 'print(3)'" },
            },
          },
          { requestId: "req_c02_post_2", text: "done" },
        ];
        coordinator.observedRequestIds = [];
        {
          const tools = normalizedC02GatewayRegistry();
          const model = remoteModel();
          const firstLifecycle = await activateC02Lifecycle(descriptorPath, "c02-systemd-a");
          const firstScope = resolveGovernorAgentLoopRunScope(run("c02-gateway-a"));
          if (!firstScope) {
            throw new Error("First C02 lifecycle scope unavailable");
          }
          const firstTransport = productionStream(model);
          const firstAgent = new Agent({
            initialState: { model, tools: [...tools] },
            streamFn: firstTransport.streamFn,
          });
          const firstBridge = installGovernorLoopBridge({
            agent: firstAgent,
            scope: firstScope,
            now: (() => {
              let value = 200;
              return () => ++value;
            })(),
          });
          const ready = new Promise<void>((resolve) => {
            const unsubscribe = onAgentEvent((event) => {
              if (event.runId === "c02-gateway-a" && event.stream === "governor_checkpoint") {
                unsubscribe();
                firstAgent.abort();
                resolve();
              }
            });
          });
          const firstPrompt = firstAgent.prompt("start");
          await Promise.race([
            ready,
            firstPrompt.then(
              () => {
                throw new Error("First agent completed before the restart checkpoint");
              },
              (error: unknown) => {
                throw error;
              },
            ),
          ]);
          await Promise.allSettled([firstPrompt]);
          expect(firstTransport.collector.snapshot()).toMatchObject({
            requestIds: ["req_c02_pre_1", "req_c02_pre_2"],
            complete: true,
          });
          const persistedMessages = [...firstAgent.state.messages];
          firstBridge.dispose();
          await firstLifecycle.close();

          const governorStateDir = path.join(state.stateDir, "governor");
          const restoreCheckpoint = lowerCheckpointVersions(governorStateDir);
          const hostileLifecycle = await activateC02Lifecycle(descriptorPath, "c02-systemd-b");
          const hostileScope = resolveGovernorAgentLoopRunScope(run("c02-gateway-b"));
          if (!hostileScope) {
            throw new Error("Hostile C02 lifecycle scope unavailable");
          }
          hostileScope.prepareTools?.(tools);
          let hostileError: unknown;
          try {
            hostileScope.beforeTool({
              toolCallId: "c02-hostile-aggregate",
              toolName: "exec",
              args: { command: "/usr/bin/python3 -c 'print(3)'" },
              tool: hostileScope.governedTools()[1],
              now: 350,
            });
          } catch (error) {
            hostileError = error;
          }
          expect(hostileError).toBeInstanceOf(AggregateError);
          expect((hostileError as AggregateError).errors).toEqual([
            expect.objectContaining({ message: "GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID" }),
          ]);
          const hostileDatabase = new DatabaseSync(
            resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: governorStateDir }),
          );
          expect(
            hostileDatabase.prepare("SELECT count(*) AS count FROM governor_effects").get(),
          ).toEqual({ count: 2 });
          hostileDatabase.close();
          hostileScope.dispose();
          await hostileLifecycle.close();
          restoreCheckpoint();

          const secondLifecycle = await activateC02Lifecycle(descriptorPath, "c02-systemd-b");
          const secondScope = resolveGovernorAgentLoopRunScope(run("c02-gateway-b"));
          if (!secondScope) {
            throw new Error("Second C02 lifecycle scope unavailable");
          }
          const secondTransport = productionStream(model);
          const secondAgent = new Agent({
            initialState: { model, tools: [...tools], messages: persistedMessages },
            streamFn: secondTransport.streamFn,
          });
          const secondBridge = installGovernorLoopBridge({
            agent: secondAgent,
            scope: secondScope,
            now: (() => {
              let value = 400;
              return () => ++value;
            })(),
          });
          await secondAgent.prompt("resume");
          secondBridge.assertTerminal();
          expect(secondTransport.collector.snapshot()).toMatchObject({
            requestIds: ["req_c02_post_1", "req_c02_post_2"],
            complete: true,
          });
          expect(secondBridge.terminalEvidence()?.coordinatorRequestIds).toEqual([
            "req_c02_pre_1",
            "req_c02_pre_2",
            "req_c02_post_1",
            "req_c02_post_2",
          ]);
          expect(coordinator.observedRequestIds).toEqual([
            "req_c02_pre_1",
            "req_c02_pre_2",
            "req_c02_post_1",
            "req_c02_post_2",
          ]);
          const database = new DatabaseSync(
            resolveOpenClawStateSqlitePath({
              OPENCLAW_STATE_DIR: governorStateDir,
            }),
          );
          expect(database.prepare("SELECT count(*) AS count FROM governor_effects").get()).toEqual({
            count: 3,
          });
          expect(database.prepare("SELECT count(*) AS count FROM governor_evidence").get()).toEqual(
            {
              count: 3,
            },
          );
          database.close();
          secondBridge.dispose();
          await secondLifecycle.close();
        }
      },
    );
  });
});
