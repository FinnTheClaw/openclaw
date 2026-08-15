import { definePluginEntry } from "./api.js";
import { readFunctionalFinnConfig } from "./src/config.js";
import { FunctionalFinnEvidenceStore } from "./src/evidence-store.js";
import { registerFunctionalFinnMemoryTool } from "./src/memory-tool.js";
import {
  formatFunctionalFinnEvidenceContext,
  FUNCTIONAL_FINN_ENVELOPE_PROMPT,
} from "./src/prompt-contract.js";
import { createFunctionalFinnReleasePolicy } from "./src/release-policy.js";
import { createFunctionalFinnAdmission } from "./src/request-admission.js";
import { classifyFunctionalFinnRequest } from "./src/request-classifier.js";
import { FunctionalFinnTransientStore } from "./src/transient-store.js";
import { requestFunctionalFinnVerifier } from "./src/verifier-client.js";

export default definePluginEntry({
  id: "functional-finn",
  name: "Functional Finn",
  description: "Bounded Goal admission, verified memory, and fail-closed answer release.",
  register(api) {
    const config = readFunctionalFinnConfig(api.pluginConfig);
    const sessions = api.runtime.state.openSyncKeyedStore<{ agentId: string; channel: string }>({
      namespace: "functional-finn-sessions",
      maxEntries: 2_000,
      overflowPolicy: "evict-oldest",
    });
    const revisions = api.runtime.state.openSyncKeyedStore<{ requested: true }>({
      namespace: "functional-finn-revisions",
      maxEntries: 2_000,
      overflowPolicy: "evict-oldest",
    });
    const evidence = new FunctionalFinnEvidenceStore(new FunctionalFinnTransientStore(10_000));
    const policy = createFunctionalFinnReleasePolicy({
      config,
      sessions,
      revisions,
      evidence,
      verify: (request) =>
        requestFunctionalFinnVerifier({
          socketPath: config.verifierSocketPath,
          timeoutMs: config.verifierTimeoutMs,
          request,
        }),
    });
    const admission = createFunctionalFinnAdmission({
      config,
      ensureGoal: (params) => api.runtime.goals.ensure(params),
    });
    registerFunctionalFinnMemoryTool({
      api,
      config,
      evidence,
      verify: async (request) => {
        const result = await requestFunctionalFinnVerifier({
          socketPath: config.verifierSocketPath,
          timeoutMs: config.verifierTimeoutMs,
          request,
        });
        return result.ok;
      },
    });

    api.on("before_agent_run", async (event, context) => {
      policy.bindSession({
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        channel: context.channel ?? event.channelId,
      });
      if (
        context.agentId &&
        context.runId &&
        config.agentIds.includes(context.agentId) &&
        classifyFunctionalFinnRequest(event.prompt) === "substantive"
      ) {
        evidence.recordUserConfirmation({
          agentId: context.agentId,
          runId: context.runId,
          content: event.prompt,
          observedAt: Date.now(),
        });
      }
      return await admission(event, context);
    });

    api.on("before_prompt_build", (_event, context) => {
      if (
        context.sessionKey &&
        context.agentId &&
        context.channel &&
        config.agentIds.includes(context.agentId) &&
        config.channels.includes(context.channel)
      ) {
        return { appendSystemContext: FUNCTIONAL_FINN_ENVELOPE_PROMPT };
      }
      return undefined;
    });

    api.on("after_tool_call", (event, context) => {
      if (
        context.agentId &&
        context.runId &&
        context.toolCallId &&
        config.agentIds.includes(context.agentId) &&
        context.channelId &&
        config.channels.includes(context.channelId)
      ) {
        evidence.recordToolObservation({
          agentId: context.agentId,
          runId: context.runId,
          toolCallId: context.toolCallId,
          toolName: event.toolName,
          result: event.error ? { error: event.error } : event.result,
          observedAt: Date.now(),
        });
      }
    });

    api.on("agent_turn_prepare", (_event, context) => {
      if (!context.runId || !context.agentId || !config.agentIds.includes(context.agentId)) {
        return undefined;
      }
      const appendContext = formatFunctionalFinnEvidenceContext(evidence.listRun(context.runId));
      return appendContext ? { appendContext } : undefined;
    });

    api.on("before_agent_finalize", (event, context) =>
      policy.beforeFinalize({
        text: event.lastAssistantMessage,
        sessionKey: event.sessionKey ?? context.sessionKey,
        runId: event.runId ?? context.runId,
        channel: context.channel,
      }),
    );

    api.on("reply_payload_sending", async (event, context) => {
      const existingRelease = event.payload.channelData?.functionalFinnRelease;
      if (existingRelease && typeof existingRelease === "object") {
        return undefined;
      }
      const prepared = await policy.prepareReply({
        text: event.payload.text,
        sessionKey: event.sessionKey ?? context.sessionKey,
        runId: event.runId ?? context.runId,
        channel: event.channel ?? context.channelId,
        accountId: context.accountId,
        target: context.conversationId,
      });
      if (!prepared) {
        return undefined;
      }
      if ("cancel" in prepared) {
        return prepared;
      }
      return {
        payload: {
          ...event.payload,
          text: prepared.text,
          channelData: {
            ...event.payload.channelData,
            functionalFinnRelease: {
              kind: "verified_candidate",
              candidateText: prepared.text,
              receipt: prepared.receipt,
            },
          },
        },
      };
    });
  },
});
