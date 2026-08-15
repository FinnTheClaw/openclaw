import { definePluginEntry } from "./api.js";
import { readFunctionalFinnConfig } from "./src/config.js";
import { FunctionalFinnEvidenceStore } from "./src/evidence-store.js";
import {
  createFunctionalFinnExternalReleasePolicy,
  type FunctionalFinnExternalCandidateRecord,
} from "./src/external-release-policy.js";
import { registerFunctionalFinnMemoryTool } from "./src/memory-tool.js";
import {
  formatFunctionalFinnEvidenceContext,
  FUNCTIONAL_FINN_ENVELOPE_PROMPT,
} from "./src/prompt-contract.js";
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
    const revisions = api.runtime.state.openSyncKeyedStore<{ requested: true }>({
      namespace: "functional-finn-revisions",
      maxEntries: 2_000,
      overflowPolicy: "reject-new",
    });
    const candidates = api.runtime.state.openSyncKeyedStore<FunctionalFinnExternalCandidateRecord>({
      namespace: "functional-finn-external-candidates",
      maxEntries: 2_000,
      overflowPolicy: "reject-new",
    });
    const evidence = new FunctionalFinnEvidenceStore(new FunctionalFinnTransientStore(10_000));
    const externalRelease = createFunctionalFinnExternalReleasePolicy({ candidates, revisions });
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
          socketPath: config.semanticSupportSocketPath,
          timeoutMs: config.semanticSupportTimeoutMs,
          request,
        });
        return result.ok;
      },
    });

    api.on("before_agent_run", async (event, context) => {
      externalRelease.bindRun(context.runId, context.channelContext);
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

    api.on("agent_turn_prepare", (_event, context) => {
      if (!context.runId || !context.agentId || !config.agentIds.includes(context.agentId)) {
        return undefined;
      }
      const appendContext = formatFunctionalFinnEvidenceContext(evidence.listRun(context.runId));
      const ingress = externalRelease.evidenceForRun(context.runId);
      const externalContext = ingress
        ? `[${ingress.ingressId}] observedAt=${ingress.receivedAt}\n${ingress.content}`
        : undefined;
      const combined = externalContext ?? appendContext;
      return combined ? { appendContext: combined } : undefined;
    });

    api.on("before_agent_finalize", (event, context) =>
      externalRelease.beforeFinalize({
        text: event.lastAssistantMessage,
        sessionKey: event.sessionKey ?? context.sessionKey,
        runId: event.runId ?? context.runId,
        channelContext: context.channelContext,
      }),
    );

    api.on("reply_payload_sending", async (event, context) => {
      const existingEscrow = event.payload.channelData?.functionalFinnExternalEscrow;
      if (existingEscrow && typeof existingEscrow === "object") {
        return undefined;
      }
      const prepared = externalRelease.prepareReply({
        text: event.payload.text,
        sessionKey: event.sessionKey ?? context.sessionKey,
        runId: event.runId ?? context.runId,
      });
      if (!prepared) {
        return undefined;
      }
      if ("blocked" in prepared) {
        return { cancel: true, reason: "Functional Finn external escrow is not releaseable" };
      }
      return {
        payload: {
          ...event.payload,
          text: prepared.escrow.candidate.message,
          channelData: {
            ...event.payload.channelData,
            functionalFinnExternalEscrow: prepared.escrow,
          },
        },
      };
    });

    api.on("agent_end", (event, context) => {
      externalRelease.clearRun(event.runId ?? context.runId);
    });
  },
});
