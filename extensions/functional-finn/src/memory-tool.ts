import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import type { FunctionalFinnConfig } from "./config.js";
import type { FunctionalFinnEvidenceStore } from "./evidence-store.js";
import { admitFunctionalFinnMemory } from "./memory-admission.js";
import { FunctionalFinnMemoryLedger, type FunctionalFinnMemoryRecord } from "./memory-ledger.js";
import { materializeFunctionalFinnMemory } from "./memory-materializer.js";
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
    maxEntries: 2_000,
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
            verifySupport: ({ claim, evidence: source, sourceStart, sourceEnd, sourceQuote }) =>
              params.verify({
                operation: "verify_memory",
                agentId,
                claim,
                evidence: source,
                sourceStart,
                sourceEnd,
                sourceQuote,
              }),
            materialize: () =>
              materializeFunctionalFinnMemory({
                workspaceDir,
                loadRecords: () => ledger.recall({ agentId, now: Date.now(), limit: 50 }),
              }),
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
