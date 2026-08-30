import type { GovernorActionIntent } from "../tasks/governor/action-intent.js";
import type { GovernorEventRecord } from "../tasks/governor/events.js";
import type { GovernorEvidenceRecord } from "../tasks/governor/evidence.js";
import type { GovernorCheckpoint } from "../tasks/governor/planning-policy.js";
import type { GovernorEffectRecord } from "../tasks/governor/tool-outcome.js";
import type { GovernorTaskProjection } from "../tasks/governor/types.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "./governor-c02-simple-efficiency-policy.js";

export const SCHEMA = "openclaw.governor-c02-runtime-attestation/v1" as const;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const FINN_REQUEST_ID = /^req_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
export const CHECKPOINT_PREFIX = "c02-runtime-binding:";

export type GovernorC02StoreSnapshot = Readonly<{
  task: GovernorTaskProjection;
  highwater: Readonly<{
    sourceBindingRef: string;
    sourceSequence: number;
    sourceMessageRef: string;
    taskId: string;
    updatedAt: number;
  }>;
  events: readonly GovernorEventRecord[];
  intents: readonly GovernorActionIntent[];
  effects: readonly GovernorEffectRecord[];
  evidence: readonly GovernorEvidenceRecord[];
  checkpoints: readonly GovernorCheckpoint[];
}>;

export type Body = Readonly<{
  schema: typeof SCHEMA;
  moduleId: typeof C02_SIMPLE_EFFICIENCY_ID;
  moduleVersion: typeof C02_SIMPLE_EFFICIENCY_VERSION;
  hostDescriptorDigest: string;
  installedToolDigest: string;
  runBindingDigest: string;
  runIdentityDigest: string;
  modulePlanDigest: string;
  runId: string;
  sessionId: string;
  gatewayInvocationId: string;
  initialGatewayInvocationId: string;
  systemdInvocationId: string;
  initialSystemdInvocationId: string;
  checkpointId: string;
  checkpointDigest: string;
  checkpointCreatedAt: number;
  decision: "complete";
  reasonCode: "C02_EXACT_FLOW_ATTESTED";
  coordinatorRequestIds: readonly string[];
  taskId: string;
  opaqueFlowId: string;
  scopeKey: string;
  scopeDigest: string;
  sourceEventId: string;
  sourceEventPayloadDigest: string;
  sourceMessageDigest: string;
  sourceHighwater: number;
  sourceHighwaterUpdatedAt: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  taskCreatedAt: number;
  taskUpdatedAt: number;
  taskCompletedAt: number;
  turnChainDigest: string;
  turnTimestamps: readonly number[];
  actionChainDigest: string;
  actionTimestamps: readonly number[];
  evidenceChainDigest: string;
  evidenceTimestamps: readonly number[];
  opaqueActionTargets: readonly string[];
  toolResults: readonly Readonly<{
    effectId: string;
    toolName: "read" | "exec";
    resultDigest: string;
  }>[];
}>;

export type Candidate = Body & Readonly<{ __candidate?: never }>;
export type Signed = Body &
  Readonly<{
    issuedAt: number;
    authorityKeyId: "host-receipt-v1";
    authorityVersion: 1;
    signature: string;
  }>;

export type GovernorC02AttestationAuthority = Readonly<{
  issue(candidate: Candidate): Signed;
  verify(attestation: Signed, candidate: Candidate): boolean;
}>;

export function fail(): never {
  throw new Error("GOVERNOR_C02_ATTESTATION_SEMANTICS_INVALID");
}

export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

export function dataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !item.enumerable || !("value" in item))) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]));
}

export function exactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");
}

export function governorC02TimingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
import crypto from "node:crypto";
