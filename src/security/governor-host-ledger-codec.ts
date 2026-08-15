// Pure signed-record codec for the host anti-rollback ledger.
import crypto from "node:crypto";
import { canonicalGovernorJson, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";

export type GovernorLedgerKind =
  | "approval"
  | "delivery"
  | "execution"
  | "ingress"
  | "memory"
  | "task";
export type GovernorLedgerStatus =
  | "approved"
  | "cancel_pending"
  | "certified"
  | "claimed"
  | "completed"
  | "consumed"
  | "crashed"
  | "memory_current"
  | "memory_retired"
  | "revoked"
  | "task_current"
  | "task_intent"
  | "terminated";
/** Causes that may enter memory_retired; contradiction/supersession stay current-or-stale. */
export type GovernorMemoryRetirementReason = "expiry" | "explicit_forget";
export type GovernorLedgerTaskFence = Readonly<{
  scopeDigest: string;
  authenticatedSourceSequence: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  leaseEpoch: number;
  executionGeneration: number;
  stateDigest: string;
  operationDigest: string;
  projectionDigest: string;
}>;
export type GovernorLedgerOrdering = Readonly<{
  scopeEpoch: number;
  observedAt: number;
  recordedAt: number;
  sourceRank: number;
  confidenceMillionths: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  taskDigest: string;
}>;
export type GovernorLedgerAppendInput = Readonly<{
  kind: GovernorLedgerKind;
  key: string;
  generation: number;
  status: GovernorLedgerStatus;
  bindingDigest: string;
  retirementReason?: GovernorMemoryRetirementReason;
  ordering?: GovernorLedgerOrdering;
  taskFence?: GovernorLedgerTaskFence;
  priorTaskFence?: GovernorLedgerTaskFence;
  priorBindingDigest?: string;
}>;
export type GovernorLedgerEntry = Readonly<
  GovernorLedgerAppendInput & {
    sequence: number;
    keyId: string;
    keyVersion: 1;
    priorDigest: string;
    digest: string;
    signature: string;
  }
>;
export type GovernorLedgerHead = Readonly<{
  sequence: number;
  digest: string;
  highWaterDigest: string;
  keyId: string;
  keyVersion: 1;
  entries?: readonly GovernorLedgerEntry[];
  signature: string;
}>;
export type GovernorLedgerState = Readonly<{
  generation: number;
  status: GovernorLedgerStatus;
  digest: string;
  bindingDigest: string;
  retirementReason?: GovernorMemoryRetirementReason;
  ordering?: GovernorLedgerOrdering;
  taskFence?: GovernorLedgerTaskFence;
  priorTaskFence?: GovernorLedgerTaskFence;
  priorBindingDigest?: string;
}>;

export const GOVERNOR_LEDGER_EMPTY_DIGEST = crypto
  .createHash("sha256")
  .update("governor-host-ledger-v9:genesis")
  .digest("hex");

function sha256(value: GovernorJsonValue): string {
  return crypto.createHash("sha256").update(canonicalGovernorJson(value)).digest("hex");
}

function hmac(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

export function governorLedgerKeyId(key: string): string {
  return sha256({ purpose: "governor-host-ledger-key", key });
}

function equal(left: string, right: string): boolean {
  return (
    left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

export function isValidGovernorTaskFence(fence: GovernorLedgerTaskFence): boolean {
  return (
    /^[a-f0-9]{64}$/u.test(fence.scopeDigest) &&
    Number.isSafeInteger(fence.authenticatedSourceSequence) &&
    fence.authenticatedSourceSequence >= 0 &&
    Number.isSafeInteger(fence.taskVersion) &&
    fence.taskVersion >= 0 &&
    Number.isSafeInteger(fence.objectiveRevision) &&
    fence.objectiveRevision >= 0 &&
    Number.isSafeInteger(fence.planVersion) &&
    fence.planVersion >= 0 &&
    Number.isSafeInteger(fence.leaseEpoch) &&
    fence.leaseEpoch >= 0 &&
    Number.isSafeInteger(fence.executionGeneration) &&
    fence.executionGeneration >= 0 &&
    /^[a-f0-9]{64}$/u.test(fence.stateDigest) &&
    /^[a-f0-9]{64}$/u.test(fence.operationDigest) &&
    /^[a-f0-9]{64}$/u.test(fence.projectionDigest)
  );
}

export function isValidGovernorLedgerOrdering(ordering: GovernorLedgerOrdering): boolean {
  return (
    Number.isSafeInteger(ordering.scopeEpoch) &&
    ordering.scopeEpoch >= 0 &&
    Number.isSafeInteger(ordering.observedAt) &&
    ordering.observedAt >= 0 &&
    Number.isSafeInteger(ordering.recordedAt) &&
    ordering.recordedAt >= ordering.observedAt &&
    Number.isSafeInteger(ordering.sourceRank) &&
    ordering.sourceRank >= 0 &&
    Number.isSafeInteger(ordering.confidenceMillionths) &&
    ordering.confidenceMillionths >= 0 &&
    ordering.confidenceMillionths <= 1_000_000 &&
    Number.isSafeInteger(ordering.taskVersion) &&
    ordering.taskVersion >= 0 &&
    Number.isSafeInteger(ordering.objectiveRevision) &&
    ordering.objectiveRevision >= 0 &&
    Number.isSafeInteger(ordering.planVersion) &&
    ordering.planVersion >= 0 &&
    /^[a-f0-9]{64}$/u.test(ordering.taskDigest)
  );
}

function unsignedEntry(entry: Omit<GovernorLedgerEntry, "digest" | "signature">) {
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    key: entry.key,
    generation: entry.generation,
    status: entry.status,
    bindingDigest: entry.bindingDigest,
    ...(entry.retirementReason ? { retirementReason: entry.retirementReason } : {}),
    ...(entry.ordering ? { ordering: entry.ordering } : {}),
    ...(entry.taskFence ? { taskFence: entry.taskFence } : {}),
    ...(entry.priorTaskFence ? { priorTaskFence: entry.priorTaskFence } : {}),
    ...(entry.priorBindingDigest ? { priorBindingDigest: entry.priorBindingDigest } : {}),
    keyId: entry.keyId,
    keyVersion: entry.keyVersion,
    priorDigest: entry.priorDigest,
  };
}

export function assertGovernorLedgerEntry(
  entry: GovernorLedgerEntry,
  index: number,
  priorDigest: string,
  signingKey: string,
): void {
  const unsigned = unsignedEntry(entry);
  if (
    entry.sequence !== index + 1 ||
    !Number.isSafeInteger(entry.generation) ||
    entry.generation < 0 ||
    (entry.ordering !== undefined && !isValidGovernorLedgerOrdering(entry.ordering)) ||
    (entry.taskFence !== undefined && !isValidGovernorTaskFence(entry.taskFence)) ||
    (entry.priorTaskFence !== undefined && !isValidGovernorTaskFence(entry.priorTaskFence)) ||
    (entry.kind === "task") !== (entry.taskFence !== undefined) ||
    (entry.priorTaskFence === undefined) !== (entry.priorBindingDigest === undefined) ||
    (entry.priorBindingDigest !== undefined && !/^[a-f0-9]{64}$/u.test(entry.priorBindingDigest)) ||
    (entry.status !== "task_intent" && entry.priorTaskFence !== undefined) ||
    (entry.kind !== "task" && entry.priorTaskFence !== undefined) ||
    (entry.retirementReason !== undefined &&
      (entry.status !== "memory_retired" ||
        (entry.retirementReason !== "expiry" && entry.retirementReason !== "explicit_forget"))) ||
    entry.priorDigest !== priorDigest ||
    entry.keyId !== governorLedgerKeyId(signingKey) ||
    entry.keyVersion !== 1 ||
    !equal(entry.digest, sha256(unsigned)) ||
    !equal(entry.signature, hmac(signingKey, { ...unsigned, digest: entry.digest }))
  ) {
    throw new Error("GOVERNOR_HOST_LEDGER_INTEGRITY_INVALID");
  }
}

export function parseGovernorLedgerJournal(raw: string, signingKey: string): GovernorLedgerEntry[] {
  if (!raw) {
    return [];
  }
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  const entries: GovernorLedgerEntry[] = [];
  let priorDigest = GOVERNOR_LEDGER_EMPTY_DIGEST;
  for (const [index, line] of lines.entries()) {
    if (!line) {
      throw new Error("GOVERNOR_HOST_LEDGER_INTEGRITY_INVALID");
    }
    let entry: GovernorLedgerEntry;
    try {
      entry = JSON.parse(line) as GovernorLedgerEntry;
    } catch {
      throw new Error("GOVERNOR_HOST_LEDGER_INTEGRITY_INVALID");
    }
    assertGovernorLedgerEntry(entry, index, priorDigest, signingKey);
    entries.push(entry);
    priorDigest = entry.digest;
  }
  return entries;
}

function stateKey(entry: Pick<GovernorLedgerEntry, "kind" | "key">): string {
  return `${entry.kind}:${entry.key}`;
}

export function governorLedgerStates(
  entries: readonly GovernorLedgerEntry[],
): Map<string, GovernorLedgerState> {
  const states = new Map<string, GovernorLedgerState>();
  for (const entry of entries) {
    states.set(stateKey(entry), {
      generation: entry.generation,
      status: entry.status,
      digest: entry.digest,
      bindingDigest: entry.bindingDigest,
      ...(entry.retirementReason ? { retirementReason: entry.retirementReason } : {}),
      ...(entry.ordering ? { ordering: entry.ordering } : {}),
      ...(entry.taskFence ? { taskFence: entry.taskFence } : {}),
      ...(entry.priorTaskFence ? { priorTaskFence: entry.priorTaskFence } : {}),
      ...(entry.priorBindingDigest ? { priorBindingDigest: entry.priorBindingDigest } : {}),
    });
  }
  return states;
}

function stateJson(key: string, state: GovernorLedgerState): GovernorJsonValue {
  return {
    key,
    generation: state.generation,
    status: state.status,
    digest: state.digest,
    bindingDigest: state.bindingDigest,
    ...(state.retirementReason ? { retirementReason: state.retirementReason } : {}),
    ...(state.ordering ? { ordering: state.ordering } : {}),
    ...(state.taskFence ? { taskFence: state.taskFence } : {}),
    ...(state.priorTaskFence ? { priorTaskFence: state.priorTaskFence } : {}),
    ...(state.priorBindingDigest ? { priorBindingDigest: state.priorBindingDigest } : {}),
  };
}

export function governorLedgerHighWaterDigest(entries: readonly GovernorLedgerEntry[]): string {
  return sha256(
    [...governorLedgerStates(entries)]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, state]) => stateJson(key, state)),
  );
}

export function makeGovernorLedgerHead(
  entries: readonly GovernorLedgerEntry[],
  signingKey: string,
): GovernorLedgerHead {
  const unsigned = {
    sequence: entries.length,
    digest: entries.at(-1)?.digest ?? GOVERNOR_LEDGER_EMPTY_DIGEST,
    highWaterDigest: governorLedgerHighWaterDigest(entries),
    keyId: governorLedgerKeyId(signingKey),
    keyVersion: 1 as const,
    entries: [...entries],
  };
  return { ...unsigned, signature: hmac(signingKey, unsigned) };
}

export function parseGovernorLedgerHead(raw: string, signingKey: string): GovernorLedgerHead {
  let head: GovernorLedgerHead;
  try {
    head = JSON.parse(raw) as GovernorLedgerHead;
  } catch {
    throw new Error("GOVERNOR_HOST_LEDGER_HEAD_INVALID");
  }
  const unsigned = {
    sequence: head.sequence,
    digest: head.digest,
    highWaterDigest: head.highWaterDigest,
    keyId: head.keyId,
    keyVersion: head.keyVersion,
    ...(head.entries ? { entries: [...head.entries] } : {}),
  };
  if (
    head.keyId !== governorLedgerKeyId(signingKey) ||
    head.keyVersion !== 1 ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    !equal(head.signature, hmac(signingKey, unsigned))
  ) {
    throw new Error("GOVERNOR_HOST_LEDGER_HEAD_INVALID");
  }
  if (head.entries) {
    let prior = GOVERNOR_LEDGER_EMPTY_DIGEST;
    for (const [index, entry] of head.entries.entries()) {
      assertGovernorLedgerEntry(entry, index, prior, signingKey);
      prior = entry.digest;
    }
    if (
      head.entries.length !== head.sequence ||
      head.digest !== (head.entries.at(-1)?.digest ?? GOVERNOR_LEDGER_EMPTY_DIGEST) ||
      head.highWaterDigest !== governorLedgerHighWaterDigest(head.entries)
    ) {
      throw new Error("GOVERNOR_HOST_LEDGER_HEAD_INVALID");
    }
  }
  return head;
}

export function createGovernorLedgerEntry(
  entries: readonly GovernorLedgerEntry[],
  input: GovernorLedgerAppendInput,
  signingKey: string,
): GovernorLedgerEntry {
  const unsigned = {
    sequence: entries.length + 1,
    ...input,
    keyId: governorLedgerKeyId(signingKey),
    keyVersion: 1 as const,
    priorDigest: entries.at(-1)?.digest ?? GOVERNOR_LEDGER_EMPTY_DIGEST,
  };
  const digest = sha256(unsigned);
  return { ...unsigned, digest, signature: hmac(signingKey, { ...unsigned, digest }) };
}

export function sameGovernorLedgerMetadata(
  input: GovernorLedgerAppendInput,
  state: GovernorLedgerState,
): boolean {
  return (
    (input.ordering === undefined) === (state.ordering === undefined) &&
    (input.taskFence === undefined) === (state.taskFence === undefined) &&
    (input.priorTaskFence === undefined) === (state.priorTaskFence === undefined) &&
    input.priorBindingDigest === state.priorBindingDigest &&
    (!input.ordering ||
      !state.ordering ||
      canonicalGovernorJson(input.ordering) === canonicalGovernorJson(state.ordering)) &&
    (!input.taskFence ||
      !state.taskFence ||
      canonicalGovernorJson(input.taskFence) === canonicalGovernorJson(state.taskFence)) &&
    (!input.priorTaskFence ||
      !state.priorTaskFence ||
      canonicalGovernorJson(input.priorTaskFence) ===
        canonicalGovernorJson(state.priorTaskFence)) &&
    input.retirementReason === state.retirementReason
  );
}
