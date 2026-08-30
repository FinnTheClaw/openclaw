import type { AgentTool } from "../../packages/agent-core/src/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { governorDigest, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import type { GovernorCapabilityDefinition } from "../tasks/governor/capability-registry.js";
import type { GovernorController } from "../tasks/governor/controller.js";
import { withGovernorC02AtomicSnapshot } from "../tasks/governor/store-c02-attestation.js";
import type { GovernorSqliteStore } from "../tasks/governor/store.js";
import type { GovernorAgentLoopConfiguration } from "./governor-agent-loop-config.js";
import type {
  GovernorAgentLoopRunInput,
  GovernorAgentLoopRunScope,
} from "./governor-agent-loop-types.js";
import { createGovernorC02AttestationAuthority } from "./governor-c02-runtime-attestation-authority.js";
import {
  CHECKPOINT_PREFIX,
  FINN_REQUEST_ID,
  SHA256,
  type Candidate,
  type GovernorC02AttestationAuthority,
  type Signed,
  dataRecord,
  fail,
} from "./governor-c02-runtime-attestation-model.js";
import { validateGovernorC02Snapshot } from "./governor-c02-runtime-attestation-validation.js";
import {
  C02_CRITERIA_TEMPLATE,
  C02_MAX_TURNS,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  evaluateGovernorC02Policy,
  governorC02RunBindingDigest,
  prepareGovernorC02Run,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";
import {
  createGovernorInstalledToolAttestor,
  governorInstalledToolDefinitionDigest,
  type OpaqueInstalledToolHandle,
} from "./governor-installed-tool-attestor.js";

export function createGovernorC02AttestationOwnerCapability(params: {
  sign: (value: GovernorJsonValue) => string;
}) {
  const authority = createGovernorC02AttestationAuthority(params);
  let closed = false;
  return Object.freeze({
    create(input: Omit<Parameters<typeof createGovernorC02AttestationOwner>[0], "authority">) {
      if (closed) {
        throw new Error("GOVERNOR_C02_ATTESTATION_CAPABILITY_CLOSED");
      }
      return createGovernorC02AttestationOwner({ ...input, authority });
    },
    close() {
      closed = true;
    },
  });
}

function criterionValue(args: unknown, key: string): string | undefined {
  const record = dataRecord(args);
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function requireFinnRequestIds(
  value: unknown,
  complete: unknown,
  prior: readonly string[] = [],
): readonly string[] {
  try {
    if (
      complete !== true ||
      !Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.entries(Object.getOwnPropertyDescriptors(value)).some(
        ([key, descriptor]) =>
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/u.test(key) || !descriptor.enumerable || !("value" in descriptor)),
      ) ||
      value.length !== prior.length + 1 ||
      value.some((item) => typeof item !== "string" || !FINN_REQUEST_ID.test(item)) ||
      new Set(value).size !== value.length ||
      prior.some((item, index) => value[index] !== item)
    ) {
      fail();
    }
    return Object.freeze([...value] as string[]);
  } catch {
    fail();
  }
}

/** @internal Creates only standard run scopes; no raw issuer, verifier, snapshot, or result escapes. */
function createGovernorC02AttestationOwner(params: {
  controller: GovernorController;
  store: GovernorSqliteStore;
  authority: GovernorC02AttestationAuthority;
  capabilities: readonly GovernorCapabilityDefinition[];
  systemdInvocationId?: string;
}) {
  const activeTasks = new Set<string>();
  const issuedTasks = new Set<string>();
  let closed = false;
  return Object.freeze({
    wrap(input: {
      scope: GovernorAgentLoopRunScope;
      run: GovernorAgentLoopRunInput;
      config: GovernorAgentLoopConfiguration;
      modulePlanDigest: string;
      hostDescriptorDigest: string;
    }): GovernorAgentLoopRunScope {
      if (closed || input.scope.mode !== "enforce") {
        throw new Error("GOVERNOR_C02_ATTESTATION_OWNER_CLOSED");
      }
      const systemdInvocationId = params.systemdInvocationId;
      if (
        typeof systemdInvocationId !== "string" ||
        systemdInvocationId.length === 0 ||
        systemdInvocationId.length > 256 ||
        systemdInvocationId.trim() !== systemdInvocationId
      ) {
        fail();
      }
      let prepared: GovernorC02PreparedRun | undefined;
      let attestor: ReturnType<typeof createGovernorInstalledToolAttestor> | undefined;
      let handles: readonly OpaqueInstalledToolHandle[] = [];
      let governed: readonly AgentTool[] = [];
      let sealed: Readonly<{ candidate: Candidate; result: Signed }> | undefined;
      let disposed = false;
      const taskId = input.scope.taskId;
      if (activeTasks.has(taskId) || issuedTasks.has(taskId)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_TASK_ALREADY_BOUND");
      }
      activeTasks.add(taskId);
      const currentTask = params.store.loadTask(taskId as never);
      type RestartBinding = Readonly<{
        taskId: string;
        sessionId: string;
        systemdInvocationId: string;
        gatewayInvocationId: string;
        hostDescriptorDigest: string;
        modulePlanDigest: string;
        installedToolDigest: string;
      }>;
      let restartBinding: RestartBinding | undefined;
      for (const checkpoint of params.store.checkpoints.list(taskId as never)) {
        const fact = checkpoint.verifiedFacts.find((item) =>
          item.claim.startsWith(CHECKPOINT_PREFIX),
        );
        if (!fact) {
          continue;
        }
        try {
          const parsed = JSON.parse(fact.claim.slice(CHECKPOINT_PREFIX.length)) as RestartBinding;
          if (
            governorDigest(parsed as unknown as GovernorJsonValue) !== fact.evidenceDigest ||
            parsed.taskId !== taskId ||
            currentTask?.flowId !==
              params.store.opaqueReference("flow-id", parsed.gatewayInvocationId) ||
            parsed.sessionId !== input.run.sessionId ||
            parsed.systemdInvocationId === systemdInvocationId ||
            parsed.gatewayInvocationId === input.run.runId ||
            parsed.hostDescriptorDigest !== input.hostDescriptorDigest ||
            parsed.modulePlanDigest !== input.modulePlanDigest
          ) {
            fail();
          }
          restartBinding = Object.freeze(parsed);
        } catch {
          fail();
        }
      }
      let restartValidated = false;
      let checkpointPending = false;
      const admittedCriteria = new WeakMap<object, string>();
      let coordinatorRequestIds: readonly string[] = [];
      for (const event of params.store.listEvents(taskId as never)) {
        const payload = dataRecord(event.payload);
        if (
          payload &&
          event.eventType === "runtime_model_turn_recorded" &&
          payload.executionGeneration === currentTask?.executionGeneration
        ) {
          coordinatorRequestIds = requireFinnRequestIds(
            payload.finnRequestIds,
            payload.finnRequestIdEvidenceComplete,
            coordinatorRequestIds,
          );
        }
      }
      const currentCandidate = (): Candidate => {
        if (!prepared) {
          throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_UNPREPARED");
        }
        return withGovernorC02AtomicSnapshot({
          store: params.store,
          taskId: taskId as never,
          consume: (snapshot) =>
            validateGovernorC02Snapshot({
              store: params.store,
              run: input.run,
              prepared: prepared!,
              modulePlanDigest: input.modulePlanDigest,
              initialGatewayInvocationId: restartBinding?.gatewayInvocationId ?? input.run.runId,
              systemdInvocationId,
              snapshot,
            }),
        });
      };
      const prepare = (installedTools: readonly AgentTool[]) => {
        if (prepared) {
          throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_ALREADY_PREPARED");
        }
        input.scope.prepareTools?.(installedTools);
        const policyTools = input.scope.governedTools();
        governed = (["read", "exec"] as const).map((toolName) => {
          const matches = installedTools.filter((tool) => tool.name === toolName);
          if (matches.length !== 1) {
            fail();
          }
          return matches[0]!;
        });
        if (
          new Set(installedTools).size !== installedTools.length ||
          policyTools.length !== 2 ||
          policyTools[0]?.name !== "read" ||
          policyTools[1]?.name !== "exec" ||
          policyTools[0] !== governed[0] ||
          policyTools[1] !== governed[1]
        ) {
          fail();
        }
        attestor = createGovernorInstalledToolAttestor();
        handles = governed.map((tool) => {
          const binding = input.config.toolBindings.find((item) => item.toolName === tool.name);
          const capability = params.capabilities.find(
            (item) => item.capability === binding?.capability,
          );
          if (!binding || !capability) {
            fail();
          }
          return attestor!.attest({
            tool,
            expected: {
              toolName: tool.name,
              implementationId: binding.implementationId,
              toolDefinitionDigest: governorInstalledToolDefinitionDigest(tool),
              canonicalTargetPrefixes: [...capability.canonicalTargetPrefixes].toSorted(),
            },
          });
        });
        const identities = handles.map((handle) => attestor!.registeredTool(handle));
        const read = input.config.toolBindings[0];
        const aggregate = input.config.toolBindings[1];
        const readValues = read?.criteriaByValue ? Object.entries(read.criteriaByValue) : [];
        const aggregateValues = aggregate?.criteriaByValue
          ? Object.entries(aggregate.criteriaByValue)
          : [];
        if (
          input.config.maxTurns !== C02_MAX_TURNS ||
          input.config.expectedAssistantTextDigest !== undefined ||
          read?.toolName !== "read" ||
          read.criterionArgument !== "path" ||
          aggregate?.toolName !== "exec" ||
          aggregate.criterionArgument !== "command" ||
          readValues.length !== 2 ||
          aggregateValues.length !== 1
        ) {
          fail();
        }
        const bindings = [
          ...readValues.map(([value, criterionId]) => ({ tool: read, value, criterionId })),
          ...aggregateValues.map(([value, criterionId]) => ({
            tool: aggregate,
            value,
            criterionId,
          })),
        ].map(({ tool, value, criterionId }) => {
          const identity = identities.find((item) => item.toolName === tool.toolName)!;
          return {
            toolName: tool.toolName as "read" | "exec",
            criterionId: criterionId as "c02-observe-a" | "c02-observe-b" | "c02-aggregate",
            criterionArgument: tool.criterionArgument as "path" | "command",
            criterionValue: value,
            canonicalTarget: tool.canonicalTarget,
            implementationId: identity.implementationId,
            toolDefinitionDigest: identity.toolDefinitionDigest,
          };
        });
        const material = {
          requestId: input.run.runId,
          sessionKey: input.run.sessionKey,
          hostDescriptorDigest: input.hostDescriptorDigest,
          hostToolRegistryDigest: attestor.digest(handles),
          registeredTools: identities as never,
          bindings: bindings as never,
        };
        prepared = prepareGovernorC02Run({
          ...material,
          runBindingDigest: governorC02RunBindingDigest(material),
        });
        if (restartBinding) {
          if (restartBinding.installedToolDigest !== prepared.hostToolRegistryDigest) {
            fail();
          }
          restartValidated = true;
        }
      };
      const scope: GovernorAgentLoopRunScope = Object.freeze({
        ...input.scope,
        get disposition() {
          return checkpointPending ? "checkpoint_pending" : "runnable";
        },
        prepareTools: prepare,
        governedTools: () =>
          attestor ? attestor.governedTools(handles) : input.scope.governedTools(),
        beforeTool(request) {
          if (!prepared || !attestor) {
            throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_UNPREPARED");
          }
          const handleIndex = governed.findIndex((tool) => tool.name === request.toolName);
          if (handleIndex === undefined || handleIndex < 0 || !request.tool) {
            fail();
          }
          attestor.assertBound(handles[handleIndex]!, request.tool);
          const attempted = prepared.bindings.find(
            (binding) =>
              binding.toolName === request.toolName &&
              criterionValue(request.args, binding.criterionArgument) === binding.criterionValue,
          )?.criterionId;
          const satisfied = new Set(
            params.store
              .listEvidence(taskId as never)
              .filter(
                (item) => item.admissibility === "admitted" && item.invalidatedAt === undefined,
              )
              .map((item) => item.criterionId),
          );
          const decision = evaluateGovernorC02Policy({
            run: prepared,
            projectionRequestId: prepared.requestId,
            projectionRunBindingDigest: prepared.runBindingDigest,
            criteria: C02_CRITERIA_TEMPLATE.map((criterion) => ({
              criterionId: criterion.criterionId,
              action: criterion.action,
              dependsOn: criterion.dependsOn,
              satisfied: satisfied.has(criterion.criterionId),
            })),
            ...(attempted ? { attemptedCriterionId: attempted } : {}),
          });
          if (decision.attempted.kind === "block") {
            return { kind: "block", reasonCode: decision.attempted.reasonCode };
          }
          if (checkpointPending || (attempted === "c02-aggregate" && !restartValidated)) {
            return { kind: "block", reasonCode: "C02_RESTART_CHECKPOINT_REQUIRED" };
          }
          const hostDecision = input.scope.beforeTool(request);
          if (hostDecision.kind === "allow" && hostDecision.ticket && attempted) {
            admittedCriteria.set(hostDecision.ticket.opaque, attempted);
          }
          return hostDecision;
        },
        async afterTool(observation) {
          const criterion = observation.ticket
            ? admittedCriteria.get(observation.ticket.opaque)
            : undefined;
          await input.scope.afterTool(observation);
          if (observation.ticket) {
            admittedCriteria.delete(observation.ticket.opaque);
          }
          if (criterion !== "c02-observe-b") {
            return;
          }
          if (!prepared || restartBinding || checkpointPending) {
            fail();
          }
          const evidence = params.store
            .listEvidence(taskId as never)
            .find(
              (item) =>
                item.criterionId === "c02-observe-b" &&
                item.admissibility === "admitted" &&
                item.invalidatedAt === undefined,
            );
          const evidencePayload = dataRecord(evidence?.payload);
          if (
            !evidence ||
            !evidencePayload ||
            typeof evidencePayload.effectId !== "string" ||
            typeof evidencePayload.resultDigest !== "string" ||
            !SHA256.test(evidencePayload.resultDigest)
          ) {
            fail();
          }
          const binding: RestartBinding = Object.freeze({
            taskId,
            sessionId: input.run.sessionId,
            systemdInvocationId,
            gatewayInvocationId: input.run.runId,
            hostDescriptorDigest: input.hostDescriptorDigest,
            modulePlanDigest: input.modulePlanDigest,
            installedToolDigest: prepared.hostToolRegistryDigest,
          });
          const recorded = params.controller.recordCheckpoint({
            taskId: taskId as never,
            checkpointId: `c02-restart-${taskId}`,
            verifiedFacts: [
              {
                claim: `${CHECKPOINT_PREFIX}${JSON.stringify(binding)}`,
                evidenceDigest: governorDigest(binding as unknown as GovernorJsonValue),
              },
              { claim: "c02-observe-b-admitted", evidenceDigest: evidence.evidenceDigest },
            ],
            discardedAssumptions: [],
            unresolvedQuestions: ["gateway restart required"],
            nextDiscriminatingAction: "restart gateway then execute c02-aggregate",
            now: observation.now + 1,
          });
          checkpointPending = true;
          emitAgentEvent({
            runId: input.run.runId,
            stream: "governor_checkpoint",
            sessionKey: input.run.sessionKey,
            sessionId: input.run.sessionId,
            agentId: input.run.agentId,
            data: {
              schema: "openclaw.governor-c02-checkpoint-ready/v1",
              phase: "checkpoint-ready",
              moduleId: C02_SIMPLE_EFFICIENCY_ID,
              moduleVersion: C02_SIMPLE_EFFICIENCY_VERSION,
              taskId,
              opaqueSessionId: recorded.task.scope.sessionId,
              toolCallId: observation.toolCallId,
              effectId: evidencePayload.effectId,
              toolName: "read",
              criterionId: "c02-observe-b",
              resultDigest: evidencePayload.resultDigest,
              evidenceDigest: evidence.evidenceDigest,
              sourceHighwater: recorded.task.authenticatedSourceSequence,
              taskVersion: recorded.task.taskVersion,
              checkpointId: recorded.checkpoint.checkpointId,
              checkpointDigest: governorDigest(recorded.checkpoint as unknown as GovernorJsonValue),
              checkpointCreatedAt: recorded.checkpoint.createdAt,
              gatewayInvocationId: input.run.runId,
              systemdInvocationId,
              hostDescriptorDigest: input.hostDescriptorDigest,
              modulePlanDigest: input.modulePlanDigest,
              runBindingDigest: prepared.runBindingDigest,
              installedToolDigest: prepared.hostToolRegistryDigest,
            },
          });
          await new Promise<void>((resolve) => {
            if (observation.signal?.aborted) {
              resolve();
              return;
            }
            observation.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        afterTurn(turn) {
          coordinatorRequestIds = requireFinnRequestIds(
            turn.finnRequestIds,
            turn.finnRequestIdEvidenceComplete,
            coordinatorRequestIds,
          );
          const decision = input.scope.afterTurn(turn);
          if (decision.kind === "complete" && !sealed) {
            const candidate = currentCandidate();
            const result = params.authority.issue(candidate);
            if (!params.authority.verify(result, candidate)) {
              throw new Error("GOVERNOR_C02_ATTESTATION_SIGNATURE_INVALID");
            }
            sealed = Object.freeze({ candidate, result });
            issuedTasks.add(taskId);
          }
          return decision;
        },
        assertTerminal() {
          input.scope.assertTerminal();
          const candidate = currentCandidate();
          if (!sealed || !params.authority.verify(sealed.result, candidate)) {
            throw new Error("GOVERNOR_C02_ATTESTATION_SIGNATURE_INVALID");
          }
        },
        terminalEvidence() {
          if (!sealed) {
            throw new Error("GOVERNOR_C02_ATTESTATION_UNAVAILABLE");
          }
          if (!params.authority.verify(sealed.result, currentCandidate())) {
            throw new Error("GOVERNOR_C02_ATTESTATION_SIGNATURE_INVALID");
          }
          return sealed.result;
        },
        dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          try {
            input.scope.dispose();
          } finally {
            attestor?.close();
            activeTasks.delete(taskId);
          }
        },
      });
      return scope;
    },
    close() {
      closed = true;
    },
  });
}
