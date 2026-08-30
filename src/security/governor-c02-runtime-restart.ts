import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorAgentLoopRunInput } from "./governor-agent-loop-types.js";
import {
  CHECKPOINT_PREFIX,
  type GovernorC02StoreSnapshot,
  dataRecord,
  exactKeys,
  fail,
} from "./governor-c02-runtime-attestation-model.js";
import type { GovernorC02PreparedRun } from "./governor-c02-simple-efficiency-policy.js";

export type GovernorC02RestartBinding = Readonly<{
  taskId: string;
  sessionId: string;
  systemdInvocationId: string;
  gatewayInvocationId: string;
  hostDescriptorDigest: string;
  modulePlanDigest: string;
  installedToolDigest: string;
  sourceHighwater: number;
  taskVersion: number;
  objectiveRevision: number;
  planVersion: number;
  executionGeneration: number;
}>;

const BINDING_KEYS = [
  "taskId",
  "sessionId",
  "systemdInvocationId",
  "gatewayInvocationId",
  "hostDescriptorDigest",
  "modulePlanDigest",
  "installedToolDigest",
  "sourceHighwater",
  "taskVersion",
  "objectiveRevision",
  "planVersion",
  "executionGeneration",
] as const;

export function parseGovernorC02RestartBinding(claim: string): GovernorC02RestartBinding {
  try {
    const parsed = dataRecord(JSON.parse(claim.slice(CHECKPOINT_PREFIX.length)));
    if (
      !parsed ||
      !exactKeys(parsed, BINDING_KEYS) ||
      BINDING_KEYS.slice(0, 7).some(
        (key) => typeof parsed[key] !== "string" || !(parsed[key] as string).trim(),
      ) ||
      BINDING_KEYS.slice(7).some(
        (key) => !Number.isSafeInteger(parsed[key]) || (parsed[key] as number) < 0,
      )
    ) {
      fail();
    }
    return Object.freeze(parsed) as unknown as GovernorC02RestartBinding;
  } catch {
    fail();
  }
}

export function assertGovernorC02RestartCheckpoint(params: {
  run: GovernorAgentLoopRunInput;
  prepared: GovernorC02PreparedRun;
  modulePlanDigest: string;
  initialGatewayInvocationId: string;
  systemdInvocationId: string;
  snapshot: GovernorC02StoreSnapshot;
  phase: "pre-aggregate" | "terminal";
}): GovernorC02RestartBinding {
  const { task, highwater, intents, effects, evidence, checkpoints } = params.snapshot;
  const checkpoint = checkpoints[0];
  const bindingFacts = checkpoint?.verifiedFacts.filter((fact) =>
    fact.claim.startsWith(CHECKPOINT_PREFIX),
  );
  const observeFacts = checkpoint?.verifiedFacts.filter(
    (fact) => fact.claim === "c02-observe-b-admitted",
  );
  if (
    checkpoints.length !== 1 ||
    !checkpoint ||
    !exactKeys(checkpoint, [
      "checkpointId",
      "taskId",
      "taskVersion",
      "objectiveRevision",
      "planVersion",
      "verifiedFacts",
      "discardedAssumptions",
      "unresolvedQuestions",
      "nextDiscriminatingAction",
      "competingHypotheses",
      "createdAt",
    ]) ||
    checkpoint.verifiedFacts.some((fact) => !exactKeys(fact, ["claim", "evidenceDigest"])) ||
    bindingFacts?.length !== 1 ||
    observeFacts?.length !== 1 ||
    checkpoint.verifiedFacts.length !== 2
  ) {
    fail();
  }
  const bindingFact = bindingFacts[0]!;
  const observeFact = observeFacts[0]!;
  const binding = parseGovernorC02RestartBinding(bindingFact.claim);
  if (
    checkpoint.checkpointId !== `c02-restart-${task.taskId}` ||
    checkpoint.taskId !== task.taskId ||
    checkpoint.objectiveRevision !== task.objectiveRevision ||
    checkpoint.planVersion !== task.planVersion ||
    checkpoint.taskVersion !== binding.taskVersion ||
    (params.phase === "pre-aggregate"
      ? checkpoint.taskVersion !== task.taskVersion
      : checkpoint.taskVersion > task.taskVersion) ||
    checkpoint.discardedAssumptions.length !== 0 ||
    checkpoint.unresolvedQuestions.length !== 1 ||
    checkpoint.unresolvedQuestions[0] !== "gateway restart required" ||
    checkpoint.nextDiscriminatingAction !== "restart gateway then execute c02-aggregate" ||
    checkpoint.competingHypotheses.length !== 0 ||
    binding.taskId !== task.taskId ||
    binding.sessionId !== params.run.sessionId ||
    binding.systemdInvocationId === params.systemdInvocationId ||
    binding.gatewayInvocationId !== params.initialGatewayInvocationId ||
    binding.gatewayInvocationId === params.run.runId ||
    binding.hostDescriptorDigest !== params.prepared.hostDescriptorDigest ||
    binding.modulePlanDigest !== params.modulePlanDigest ||
    binding.installedToolDigest !== params.prepared.hostToolRegistryDigest ||
    binding.sourceHighwater !== highwater.sourceSequence ||
    binding.objectiveRevision !== task.objectiveRevision ||
    binding.planVersion !== task.planVersion ||
    binding.executionGeneration !== task.executionGeneration ||
    bindingFact.evidenceDigest !== governorDigest(binding as unknown as GovernorJsonValue) ||
    observeFact.evidenceDigest !== evidence[1]?.evidenceDigest ||
    checkpoint.createdAt <= (evidence[1]?.observedAt ?? Number.MAX_SAFE_INTEGER) ||
    (params.phase === "pre-aggregate" &&
      (task.state === "COMPLETED" || intents[2] !== undefined || effects[2] !== undefined)) ||
    (params.phase === "terminal" && checkpoint.createdAt >= (intents[2]?.createdAt ?? -1))
  ) {
    fail();
  }
  return binding;
}
