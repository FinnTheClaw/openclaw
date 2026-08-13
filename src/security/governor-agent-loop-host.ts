/** Host-owned bridge between the durable governor and the production agent loop. */
import { governorDigest } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import { createGovernorEffectId } from "../tasks/governor/types.js";
import {
  validateGovernorAgentLoopConfiguration,
  type GovernorAgentLoopConfiguration,
} from "./governor-agent-loop-config.js";
import { createGovernorAgentLoopContract } from "./governor-agent-loop-contract.js";
import {
  buildGovernorAgentLoopProgress,
  formatGovernorAlreadySatisfiedReason,
  governorAgentLoopSafetyBudget,
} from "./governor-agent-loop-progress.js";
import { reconstructGovernorAgentLoopTurns } from "./governor-agent-loop-recovery.js";
import {
  ensureGovernorAgentLoopExecuting,
  interruptGovernorAgentLoopTool,
  recordGovernorAgentLoopToolObservation,
  type GovernorAgentLoopTicketState,
} from "./governor-agent-loop-task.js";
import { createGovernorAgentLoopTools } from "./governor-agent-loop-tool-bindings.js";
import {
  governorAgentLoopToolImplementationDigest,
  matchesHostGovernorAgentLoopTool,
} from "./governor-agent-loop-tools.js";
import {
  recordGovernorAgentLoopTurn,
  type GovernorAgentLoopTurnState,
} from "./governor-agent-loop-turn-handler.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import {
  governorAgentLoopTopLevelString,
  safeGovernorAgentLoopValue,
} from "./governor-agent-loop-values.js";
import type { HostGovernorCapabilities } from "./governor-host-contracts.js";

export type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
  GovernorAgentLoopToolDecision,
  GovernorAgentLoopToolTicket,
  GovernorAgentLoopTurnDecision,
} from "./governor-agent-loop-types.js";
export type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
type ActiveHost = Readonly<{
  config: GovernorAgentLoopConfiguration;
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
}>;
const RUN_SCOPES = new WeakSet<object>();
const TICKETS = new WeakMap<object, GovernorAgentLoopTicketState>();
let activeHost: ActiveHost | undefined;
function createScope(
  host: ActiveHost,
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope {
  const promptDigest = governorDigest(input.prompt);
  const definitions = host.config.toolBindings.map((binding) =>
    host.controller.capabilities.definition(binding.capability),
  );
  if (definitions.some((item) => !item)) {
    throw new Error("GOVERNOR_AGENT_LOOP_CAPABILITY_UNKNOWN");
  }
  const contract = createGovernorAgentLoopContract({
    promptDigest,
    config: host.config,
    definitions,
  });
  const ingress: Omit<Parameters<GovernorController["ingest"]>[0], "sourceSequence"> = {
    sourceMessageId: input.sourceMessageId,
    scope: {
      principalId: input.principalId,
      channel: input.channel,
      accountId: input.accountId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    },
    mode: host.config.criteria.length > 12 ? "DEEP" : "FOCUSED",
    profile: {
      incident: false,
      effectful: definitions.some((item) => item?.mutating),
      requiresExternalEvidence: host.config.criteria.length > 0,
      consequential: true,
      estimatedUsefulActions: host.config.criteria.length,
      independentBranches: 0,
    },
    contract,
    flowId: input.runId,
    now: input.now,
  };
  const route =
    input.sourceSequence === undefined
      ? host.controller.ingestHostSequenced(ingress)
      : host.controller.ingest({ ...ingress, sourceSequence: input.sourceSequence });
  if (route.kind === "stale") {
    throw new Error("GOVERNOR_AGENT_LOOP_STALE_INGRESS");
  }
  const taskId = route.task.taskId;
  ensureGovernorAgentLoopExecuting(host.controller, taskId, input.now + 1);
  const currentTask = host.controller.store.loadTask(taskId);
  if (!currentTask) {
    throw new Error("GOVERNOR_AGENT_LOOP_TASK_UNAVAILABLE");
  }
  const safetyBudget = governorAgentLoopSafetyBudget(host.config);
  const turns = reconstructGovernorAgentLoopTurns({
    controller: host.controller,
    taskId,
    executionGeneration: currentTask.executionGeneration,
    safetyBudget,
    now: input.now,
  });
  const progress = buildGovernorAgentLoopProgress(host.controller, taskId, host.config);
  const turnState: GovernorAgentLoopTurnState = {
    turns,
    progress,
    priorProgressFingerprint: progress.fingerprint,
    replannedAfterStagnation: false,
    skipNextStagnationCheck: false,
    toolErrorObserved: false,
    terminal: currentTask.state === "COMPLETED",
  };
  const runtimeEvents = host.controller.store.listEvents(taskId);
  const handledFailureEffects = new Set(
    runtimeEvents
      .filter((event) => event.eventType === "runtime_replan_requested")
      .flatMap((event) => {
        const payload = event.payload;
        return typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          typeof payload.sourceEffectId === "string"
          ? [payload.sourceEffectId]
          : [];
      }),
  );
  let priorGuidance = runtimeEvents.toReversed().find((event) => {
    const payload = event.payload;
    return (
      event.eventType === "runtime_replan_requested" &&
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      payload.guidanceOnly === true &&
      payload.progressDigest === progress.fingerprint
    );
  });
  if (!priorGuidance) {
    const failedEffect = host.controller.store
      .listCurrentEffects(taskId)
      .toReversed()
      .find(
        (effect) =>
          effect.outcome.semantic === "transient_failure" &&
          !handledFailureEffects.has(effect.effectId),
      );
    if (failedEffect) {
      host.controller.recordRuntimeReplanGuidance(taskId, input.now + 1, {
        reasonCode: "tool_semantic_failure",
        progressDigest: progress.fingerprint,
        sourceEffectId: failedEffect.effectId,
      });
      priorGuidance = host.controller.store
        .listEvents(taskId)
        .toReversed()
        .find((event) => {
          const payload = event.payload;
          return (
            event.eventType === "runtime_replan_requested" &&
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload) &&
            payload.guidanceOnly === true &&
            payload.progressDigest === progress.fingerprint
          );
        });
    }
  }
  if (priorGuidance) {
    turnState.replannedAfterStagnation = true;
  }
  const governedTools = createGovernorAgentLoopTools(host.config);
  const governedToolsByName = new Map(governedTools.map((tool) => [tool.name, tool]));
  const pendingTickets = new Set<object>();
  const scope: GovernorAgentLoopRunScope = Object.freeze({
    taskId,
    mode: host.config.mode,
    beforeTool(request) {
      const binding = host.config.toolBindings.find((item) => item.toolName === request.toolName);
      if (!binding) {
        if (host.config.mode === "shadow") {
          host.controller.recordRuntimeEvent({
            taskId,
            eventType: "runtime_tool_proposed",
            payload: { toolName: request.toolName, mode: "shadow", binding: "unconfigured" },
            now: request.now,
          });
          return { kind: "allow" };
        }
        return { kind: "block", reasonCode: "GOVERNOR_TOOL_NOT_BOUND" };
      }
      const args = safeGovernorAgentLoopValue(request.args);
      if (host.config.mode === "shadow") {
        host.controller.recordRuntimeEvent({
          taskId,
          eventType: "runtime_tool_proposed",
          payload: {
            toolName: binding.toolName,
            argumentsDigest: governorDigest(args),
            mode: "shadow",
          },
          now: request.now,
        });
        return { kind: "allow" };
      }
      if (
        !request.tool ||
        request.tool !== governedToolsByName.get(binding.toolName) ||
        !matchesHostGovernorAgentLoopTool(request.tool, {
          toolName: binding.toolName,
          implementationId: binding.implementationId,
        })
      ) {
        return { kind: "block", reasonCode: "GOVERNOR_TOOL_IMPLEMENTATION_MISMATCH" };
      }
      const definition = host.controller.capabilities.definition(binding.capability);
      if (!definition) {
        return { kind: "block", reasonCode: "GOVERNOR_CAPABILITY_UNAVAILABLE" };
      }
      const task = ensureGovernorAgentLoopExecuting(host.controller, taskId, request.now);
      const observationKey = governorAgentLoopTopLevelString(args, binding.criterionArgument);
      if (binding.criteriaByValue && binding.criterionArgument) {
        const allowed = Object.keys(binding.criteriaByValue);
        if (!observationKey) {
          return {
            kind: "block",
            reasonCode: `GOVERNOR_TOOL_ARGUMENT_REQUIRED:${binding.criterionArgument};ALLOWED:${allowed.join(",")}`,
          };
        }
        if (!(observationKey in binding.criteriaByValue)) {
          return {
            kind: "block",
            reasonCode: `GOVERNOR_TOOL_ARGUMENT_INVALID:${binding.criterionArgument};ALLOWED:${allowed.join(",")}`,
          };
        }
      }
      const criterionId =
        binding.criterionId ??
        (observationKey && binding.criteriaByValue
          ? binding.criteriaByValue[observationKey]
          : undefined);
      turnState.progress = buildGovernorAgentLoopProgress(host.controller, taskId, host.config);
      if (criterionId && turnState.progress.satisfiedCriteria.includes(criterionId)) {
        return {
          kind: "block",
          reasonCode: formatGovernorAlreadySatisfiedReason(turnState.progress, criterionId),
        };
      }
      const replanGuidanceDigest = governorDigest(
        host.controller.store
          .listEvents(taskId)
          .findLast((event) => event.eventType === "runtime_replan_requested")?.payload ?? null,
      );
      const effectDigest = governorDigest({
        taskId,
        objectiveRevision: task.objectiveRevision,
        planVersion: task.planVersion,
        executionGeneration: task.executionGeneration,
        toolName: binding.toolName,
        toolImplementationDigest: governorAgentLoopToolImplementationDigest(
          binding.implementationId,
        ),
        progressFingerprint: turnState.progress.fingerprint,
        replanGuidanceDigest,
        argumentsDigest: governorDigest(args),
      });
      const admission = host.controller.admitAction({
        taskId,
        executionFence: host.controller.captureExecutionFence(taskId),
        proposal: {
          effectId: createGovernorEffectId(`loop_${effectDigest.slice(0, 40)}`),
          ...(criterionId ? { criterionId } : {}),
          capability: definition.capability,
          capabilityVersion: definition.version,
          canonicalTarget: binding.canonicalTarget,
          expectedEvidence: "Host-observed tool outcome digest",
          sourceRank: definition.sourceRank,
          stopCondition: criterionId ? `criterion:${criterionId}` : "tool outcome recorded",
          mutating: definition.mutating,
          argumentsDigest: governorDigest(args),
          toolImplementationDigest: governorAgentLoopToolImplementationDigest(
            binding.implementationId,
          ),
          ...(governorAgentLoopTopLevelString(args, binding.approvalGrantArgument)
            ? {
                approvalGrantId: governorAgentLoopTopLevelString(
                  args,
                  binding.approvalGrantArgument,
                )!,
              }
            : {}),
        },
        progressVector: {
          toolName: binding.toolName,
          observationKey: observationKey ?? "none",
          progressFingerprint: turnState.progress.fingerprint,
          replanGuidance: replanGuidanceDigest,
        },
        now: request.now,
      });
      if (!admission.accepted) {
        return { kind: "block", reasonCode: "GOVERNOR_STALE_EXECUTION" };
      }
      const workerId = `loop_${governorDigest([input.runId, request.toolCallId]).slice(0, 32)}`;
      const claim = host.controller.claimActionIntent({
        intent: admission.intent,
        workerId,
        now: request.now,
      });
      if (claim.kind !== "claimed") {
        return claim.kind === "completed"
          ? { kind: "block", reasonCode: "GOVERNOR_DUPLICATE_TOOL_CALL" }
          : { kind: "block", reasonCode: "GOVERNOR_ACTION_NOT_CLAIMED" };
      }
      const started = host.controller.beginActionEffect({
        intent: claim.intent,
        workerId,
        claimEpoch: claim.intent.claimEpoch,
        now: request.now,
      });
      const resumedReadOnly =
        started.kind === "reconcile_required" &&
        !started.intent.proposal.mutating &&
        started.intent.claimedBy === workerId &&
        started.intent.claimEpoch === claim.intent.claimEpoch;
      if (started.kind !== "started" && !resumedReadOnly) {
        return { kind: "block", reasonCode: "GOVERNOR_EFFECT_NOT_STARTED" };
      }
      const runningIntent = started.intent;
      const opaque = Object.freeze({});
      TICKETS.set(opaque, {
        intent: runningIntent,
        workerId,
        claimEpoch: runningIntent.claimEpoch,
        toolCallId: request.toolCallId,
        toolName: binding.toolName,
        ...(criterionId ? { criterionId } : {}),
        ...(observationKey ? { observationKey } : {}),
      });
      pendingTickets.add(opaque);
      return { kind: "allow", ticket: Object.freeze({ opaque }) };
    },
    afterTool(observation) {
      if (host.config.mode === "shadow") {
        host.controller.recordRuntimeEvent({
          taskId,
          eventType: "runtime_tool_observed",
          payload: {
            toolName: observation.toolName,
            resultDigest: governorDigest(safeGovernorAgentLoopValue(observation.result)),
            isError: observation.isError,
          },
          now: observation.now,
        });
        return;
      }
      const state = observation.ticket ? TICKETS.get(observation.ticket.opaque) : undefined;
      if (!state) {
        throw new Error("GOVERNOR_AGENT_LOOP_TICKET_INVALID");
      }
      if (observation.toolCallId !== state.toolCallId || observation.toolName !== state.toolName) {
        throw new Error("GOVERNOR_AGENT_LOOP_OBSERVATION_BINDING_MISMATCH");
      }
      recordGovernorAgentLoopToolObservation({
        controller: host.controller,
        submitObservedReceipt: host.submitObservedReceipt,
        taskId,
        state,
        observation: {
          toolName: observation.toolName,
          result: observation.result,
          isError: observation.isError,
          now: observation.now,
        },
      });
      if (observation.isError) {
        turnState.toolErrorObserved = true;
        turnState.toolErrorEffectId = state.intent.effectId;
        turnState.skipNextStagnationCheck = true;
      }
      pendingTickets.delete(observation.ticket!.opaque);
      TICKETS.delete(observation.ticket!.opaque);
    },
    afterTurn(turn) {
      return recordGovernorAgentLoopTurn({
        controller: host.controller,
        taskId,
        config: host.config,
        currentExecutionGeneration: currentTask.executionGeneration,
        safetyBudget,
        state: turnState,
        turn,
      });
    },
    interrupt(interruption) {
      for (const opaque of pendingTickets) {
        const state = TICKETS.get(opaque);
        if (!state) {
          pendingTickets.delete(opaque);
          continue;
        }
        interruptGovernorAgentLoopTool({
          controller: host.controller,
          taskId,
          state,
          now: interruption.now,
        });
        pendingTickets.delete(opaque);
        TICKETS.delete(opaque);
      }
      if (host.controller.store.loadTask(taskId)?.state === "EXECUTING") {
        host.controller.requestRuntimeReplan(taskId, interruption.now + 1);
      }
    },
    assertTerminal() {
      if (host.config.mode === "enforce" && !turnState.terminal) {
        throw new Error(turnState.terminalReason ?? "GOVERNOR_AGENT_LOOP_INCOMPLETE");
      }
    },
    governedTools() {
      return governedTools;
    },
    dispose() {
      pendingTickets.clear();
    },
  });
  RUN_SCOPES.add(scope);
  return scope;
}
/** Trusted bootstrap-only activation. The returned closure removes this exact host. */
export function installGovernorAgentLoopHost(params: {
  controller: GovernorController;
  submitObservedReceipt: HostGovernorCapabilities["submitObservedReceipt"];
  capabilities: readonly GovernorCapabilityDefinition[];
  config: GovernorAgentLoopConfiguration;
}): () => void {
  if (activeHost) {
    throw new Error("GOVERNOR_AGENT_LOOP_HOST_ALREADY_ACTIVE");
  }
  const host = Object.freeze({
    controller: params.controller,
    submitObservedReceipt: params.submitObservedReceipt,
    config: validateGovernorAgentLoopConfiguration(params.config, params.capabilities),
  });
  activeHost = host;
  return () => {
    if (activeHost === host) {
      activeHost = undefined;
    }
  };
}
/** Read-only resolution used by the production run seam. */
export function resolveHostGovernorAgentLoopScope(
  input: GovernorAgentLoopRunInput,
): GovernorAgentLoopRunScope | undefined {
  const host = activeHost;
  if (!host) {
    return undefined;
  }
  const selected = host.config.scopes.some(
    (scope) =>
      scope.sessionKey === input.sessionKey && (!scope.agentId || scope.agentId === input.agentId),
  );
  if (!selected) {
    return undefined;
  }
  try {
    return createScope(host, input);
  } catch (error) {
    if (host.config.mode === "shadow") {
      return undefined;
    }
    throw error;
  }
}

export function isHostIssuedGovernorAgentLoopScope(scope: GovernorAgentLoopRunScope): boolean {
  return RUN_SCOPES.has(scope);
}
