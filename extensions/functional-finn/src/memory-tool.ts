import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import { resolveFunctionalFinnUtf8Span } from "./canonical-text.js";
import type { FunctionalFinnConfig } from "./config.js";
import type { FunctionalFinnEvidenceStore } from "./evidence-store.js";
import { admitFunctionalFinnMemory } from "./memory-admission.js";
import {
  FUNCTIONAL_FINN_MEMORY_MAX_RECORDS,
  FunctionalFinnMemoryLedger,
  type FunctionalFinnMemoryRecord,
} from "./memory-ledger.js";
import {
  FunctionalFinnMemoryProjector,
  type FunctionalFinnMemoryProjectionState,
} from "./memory-materializer.js";
import { createFunctionalFinnProjectionPathRegistry } from "./memory-projection-path.js";
import { FunctionalFinnMemoryProjectionService } from "./memory-projection-service.js";
import type { FunctionalFinnVerifierRequest } from "./verifier-client.js";

export function registerFunctionalFinnMemoryTool(params: {
  api: OpenClawPluginApi;
  config: FunctionalFinnConfig;
  evidence: FunctionalFinnEvidenceStore;
  verify: (
    request: Extract<FunctionalFinnVerifierRequest, { operation: "verify_memory" }>,
  ) => Promise<boolean>;
}): void {
  const store = params.api.runtime.state.openSyncKeyedStore<FunctionalFinnMemoryRecord>({
    namespace: "functional-finn-memory",
    maxEntries: FUNCTIONAL_FINN_MEMORY_MAX_RECORDS,
    overflowPolicy: "reject-new",
  });
  if (!store.update) {
    throw new Error("Functional Finn requires atomic plugin state updates");
  }
  const ledger = new FunctionalFinnMemoryLedger({
    update: (key, mutate) => store.update?.(key, mutate) ?? false,
    lookup: (key) => store.lookup(key),
    entries: () => store.entries(),
  });
  const projectionStore =
    params.api.runtime.state.openSyncKeyedStore<FunctionalFinnMemoryProjectionState>({
      namespace: "functional-finn-memory-projection",
      maxEntries: FUNCTIONAL_FINN_MEMORY_MAX_RECORDS,
      overflowPolicy: "reject-new",
    });
  if (!projectionStore.update) {
    throw new Error("Functional Finn requires atomic projection state updates");
  }
  const projectionPaths = createFunctionalFinnProjectionPathRegistry({
    agentIds: params.config.agentIds,
    workspaceForAgent: (agentId) =>
      params.api.runtime.agent.resolveAgentWorkspaceDir(params.api.config, agentId),
  });
  const projector = new FunctionalFinnMemoryProjector(
    ledger,
    {
      update: (key, mutate) => projectionStore.update?.(key, mutate) ?? false,
      lookup: (key) => projectionStore.lookup(key),
    },
    (agentId) => {
      const paths = projectionPaths.get(agentId);
      if (!paths) {
        throw new Error(`Functional Finn has no projection owner for agent ${agentId}`);
      }
      return paths;
    },
  );
  const projectionService = new FunctionalFinnMemoryProjectionService(
    projector,
    params.config.agentIds,
    (agentId, error) =>
      params.api.logger.error(
        `Functional Finn memory reconciliation failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  params.api.registerService({
    id: "functional-finn-memory-projection",
    start: () => projectionService.start(),
    stop: () => projectionService.stop(),
  });

  params.api.on("before_agent_run", async (_event, context) => {
    if (context.agentId && params.config.agentIds.includes(context.agentId)) {
      await projectionService.reconcileAgent(context.agentId);
    }
  });

  params.api.registerTool(
    (context) => {
      if (!context.agentId || !params.config.agentIds.includes(context.agentId)) {
        return null;
      }
      const agentId = context.agentId;
      const workspaceDir = context.workspaceDir;
      return {
        name: "verified_memory_admit",
        label: "Verified Memory Admission",
        description:
          "Store, replace, or tombstone one durable fact only from an exact host-issued evidence span. Never use model inference as evidence.",
        parameters: Type.Object(
          {
            factKey: Type.String({ minLength: 1, maxLength: 256 }),
            claim: Type.String({ minLength: 1, maxLength: 2_000 }),
            sourceEvidenceId: Type.String({ minLength: 1, maxLength: 512 }),
            sourceStart: Type.Integer({ minimum: 0 }),
            sourceEnd: Type.Integer({ minimum: 1 }),
            sourceQuote: Type.String({ minLength: 1, maxLength: 4_096 }),
            tombstone: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, raw) {
          if (!workspaceDir) {
            throw new Error("verified memory requires an agent workspace");
          }
          await projectionService.reconcileAgent(agentId);
          const input = raw as {
            factKey: string;
            claim: string;
            sourceEvidenceId: string;
            sourceStart: number;
            sourceEnd: number;
            sourceQuote: string;
            tombstone?: boolean;
          };
          const record = await admitFunctionalFinnMemory({
            input,
            agentId,
            now: Date.now(),
            evidence: params.evidence,
            ledger,
            verifySupport: ({ claim, evidence: source, sourceStart, sourceEnd, sourceQuote }) => {
              const span = resolveFunctionalFinnUtf8Span({
                content: source.content,
                start: sourceStart,
                end: sourceEnd,
                quote: sourceQuote,
              });
              if (!span) {
                return Promise.resolve(false);
              }
              return params.verify({
                operation: "verify_memory",
                agentId,
                claim,
                evidence: source,
                sourceStartByte: span.startByte,
                sourceEndByte: span.endByte,
                sourceQuote,
              });
            },
            reconcile: () => projectionService.reconcileAgent(agentId),
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  record.state === "tombstone"
                    ? "Verified memory retired."
                    : "Verified memory updated.",
              },
            ],
            details: {
              state: record.state,
              generation: record.generation,
              revisionDigest: record.revisionDigest,
            },
          };
        },
      };
    },
    { name: "verified_memory_admit", optional: true },
  );
}
