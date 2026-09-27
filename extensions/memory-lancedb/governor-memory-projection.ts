import type { MemoryProjectionInput } from "./hybrid-memory-index.js";

type GovernorProjectionEvent = {
  eventId: string;
  agentId: string;
  content: string;
  observedAt: number;
  validFrom?: number;
  validTo?: number;
  metadata: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Converts the durable governor event envelope into the normal memory projection. */
export function governorMemoryProjection(
  event: GovernorProjectionEvent,
  vector: number[],
): MemoryProjectionInput | undefined {
  const governor = record(event.metadata.governor);
  if (!governor) {
    return undefined;
  }
  const memoryId = typeof governor.memoryId === "string" ? governor.memoryId : undefined;
  const factKey = typeof governor.factKey === "string" ? governor.factKey : undefined;
  const scope = typeof governor.scope === "string" ? governor.scope : undefined;
  if (!memoryId || !factKey || !scope) {
    return undefined;
  }
  const confidence = typeof governor.confidence === "number" ? governor.confidence : 0;
  const authority = typeof governor.authority === "number" ? governor.authority : 0;
  const status = event.metadata.retrievalStatus === "active" ? "active" : "retracted";
  return {
    id: memoryId,
    recordType: "fact",
    text: event.content,
    vector,
    agentId: event.agentId,
    scope,
    factKey,
    category: typeof governor.category === "string" ? governor.category : "fact",
    status,
    importance: Math.max(authority, confidence),
    confidence,
    authority,
    validFrom: event.validFrom ?? event.observedAt,
    validTo: event.validTo,
    observedAt: event.observedAt,
    sourceEventId: event.eventId,
    tags: [
      "governor",
      "verified",
      typeof governor.predicate === "string" ? governor.predicate : "fact",
    ],
    updatedAt: event.observedAt,
  };
}
