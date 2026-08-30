import type { AgentTool } from "../../packages/agent-core/src/types.js";
import type { GatewayBehaviorGovernorModuleHostRegistration } from "../gateway/behavior-governor-module-host-registration.js";
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
import {
  CHECKPOINT_PREFIX,
  SCHEMA,
  SHA256,
  type Candidate,
  type GovernorC02AttestationAuthority,
  type Signed,
  dataRecord,
  deepFreeze,
  exactKeys,
  fail,
  governorC02TimingSafeEqual,
} from "./governor-c02-runtime-attestation-model.js";
import { validateGovernorC02Snapshot } from "./governor-c02-runtime-attestation-validation.js";
import { recordGovernorC02RestartCheckpoint } from "./governor-c02-runtime-checkpoint.js";
import {
  loadDurableFinnRequestIds,
  mergeFreshFinnRequestIds,
} from "./governor-c02-runtime-finn-evidence.js";
import {
  parseGovernorC02RestartBinding,
  type GovernorC02RestartBinding,
} from "./governor-c02-runtime-restart.js";
import {
  failGovernorC02Construction,
  governorC02CriterionValue,
  prepareGovernorC02InstalledTools,
} from "./governor-c02-runtime-tools.js";
import {
  C02_CRITERIA_TEMPLATE,
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
  evaluateGovernorC02Policy,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

type PreparedTools = ReturnType<typeof prepareGovernorC02InstalledTools>;

function createGovernorC02AttestationOwnerCapability(params: {
  sign: (value: GovernorJsonValue) => string;
}) {
  const candidates = new WeakSet<object>();
  const issued = new WeakSet<object>();
  const authority: GovernorC02AttestationAuthority = Object.freeze({
    issue(candidate) {
      if (!candidates.has(candidate) || issued.has(candidate)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_CANDIDATE_INVALID");
      }
      const issuedAt = Date.now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < candidate.taskCompletedAt) {
        fail();
      }
      const unsigned = {
        ...candidate,
        issuedAt,
        authorityKeyId: "host-receipt-v1" as const,
        authorityVersion: 1 as const,
      };
      const signature = params.sign({
        domain: SCHEMA,
        body: unsigned,
      } as unknown as GovernorJsonValue);
      const result = deepFreeze({ ...unsigned, signature });
      issued.add(candidate);
      return result;
    },
    verify(attestation, candidate) {
      try {
        const record = dataRecord(attestation);
        if (
          !record ||
          !exactKeys(record, [
            ...Object.keys(candidate),
            "issuedAt",
            "authorityKeyId",
            "authorityVersion",
            "signature",
          ]) ||
          record.schema !== SCHEMA ||
          record.authorityKeyId !== "host-receipt-v1" ||
          record.authorityVersion !== 1 ||
          typeof record.issuedAt !== "number" ||
          !Number.isSafeInteger(record.issuedAt) ||
          record.issuedAt < candidate.taskCompletedAt ||
          typeof record.signature !== "string" ||
          !SHA256.test(record.signature)
        ) {
          return false;
        }
        const { signature, ...unsigned } = record;
        for (const [key, value] of Object.entries(candidate)) {
          if (
            governorDigest(value as GovernorJsonValue) !==
            governorDigest(record[key] as GovernorJsonValue)
          ) {
            return false;
          }
        }
        return governorC02TimingSafeEqual(
          signature,
          params.sign({ domain: SCHEMA, body: unsigned as GovernorJsonValue }),
        );
      } catch {
        return false;
      }
    },
  });
  let closed = false;
  return Object.freeze({
    create(
      input: Omit<
        Parameters<typeof createGovernorC02AttestationOwner>[0],
        "authority" | "candidates"
      >,
    ) {
      if (closed) {
        throw new Error("GOVERNOR_C02_ATTESTATION_CAPABILITY_CLOSED");
      }
      return createGovernorC02AttestationOwner({ ...input, authority, candidates });
    },
    close() {
      closed = true;
    },
  });
}

/** @internal Creates only standard run scopes; no raw issuer, verifier, snapshot, or result escapes. */
function createGovernorC02AttestationOwner(params: {
  controller: GovernorController;
  store: GovernorSqliteStore;
  authority: GovernorC02AttestationAuthority;
  candidates: WeakSet<object>;
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
      let attestor: PreparedTools["attestor"] | undefined;
      let handles: PreparedTools["handles"] = [];
      let governed: readonly AgentTool[] = [];
      let sealed: Readonly<{ candidate: Candidate; result: Signed }> | undefined;
      let disposed = false;
      const taskId = input.scope.taskId;
      if (activeTasks.has(taskId) || issuedTasks.has(taskId)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_TASK_ALREADY_BOUND");
      }
      const currentTask = params.store.loadTask(taskId as never);
      let restartBinding: GovernorC02RestartBinding | undefined;
      for (const checkpoint of params.store.checkpoints.list(taskId as never)) {
        const fact = checkpoint.verifiedFacts.find((item) =>
          item.claim.startsWith(CHECKPOINT_PREFIX),
        );
        if (!fact) {
          continue;
        }
        try {
          const parsed = parseGovernorC02RestartBinding(fact.claim);
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
      const durableRequestIds = loadDurableFinnRequestIds(
        params.store.listEvents(taskId as never),
        currentTask?.executionGeneration,
      );
      let runRequestIds: readonly string[] = [];
      // Materialize caller-owned scope properties before acquiring task ownership so
      // hostile getters cannot strand activeTasks during construction.
      const baseScope = { ...input.scope };
      activeTasks.add(taskId);
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
              candidates: params.candidates,
            })!,
        });
      };
      const prepare = (installedTools: readonly AgentTool[]) => {
        if (prepared) {
          throw new Error("GOVERNOR_C02_ATTESTATION_TOOLS_ALREADY_PREPARED");
        }
        const installed = prepareGovernorC02InstalledTools({
          scope: input.scope,
          installedTools,
          config: input.config,
          capabilities: params.capabilities,
          run: input.run,
          hostDescriptorDigest: input.hostDescriptorDigest,
        });
        attestor = installed.attestor;
        handles = installed.handles;
        governed = installed.governed;
        prepared = installed.prepared;
        if (restartBinding) {
          if (restartBinding.installedToolDigest !== prepared.hostToolRegistryDigest) {
            fail();
          }
        }
      };
      try {
        const scope: GovernorAgentLoopRunScope = Object.freeze({
          ...baseScope,
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
            if (handleIndex < 0 || !request.tool) {
              fail();
            }
            attestor.assertBound(handles[handleIndex]!, request.tool);
            const attempted = prepared.bindings.find(
              (binding) =>
                binding.toolName === request.toolName &&
                governorC02CriterionValue(request.args, binding.criterionArgument) ===
                  binding.criterionValue,
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
            if (checkpointPending || (attempted === "c02-aggregate" && !restartBinding)) {
              return { kind: "block", reasonCode: "C02_RESTART_CHECKPOINT_REQUIRED" };
            }
            if (attempted === "c02-aggregate" && !restartValidated) {
              const currentPrepared = prepared;
              withGovernorC02AtomicSnapshot({
                store: params.store,
                taskId: taskId as never,
                consume: (snapshot) =>
                  validateGovernorC02Snapshot({
                    store: params.store,
                    run: input.run,
                    prepared: currentPrepared,
                    modulePlanDigest: input.modulePlanDigest,
                    initialGatewayInvocationId: restartBinding!.gatewayInvocationId,
                    systemdInvocationId,
                    snapshot,
                    phase: "pre-aggregate",
                    candidates: params.candidates,
                  }),
              });
              restartValidated = true;
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
            const checkpointTask = params.store.loadTask(taskId as never);
            if (!checkpointTask) {
              fail();
            }
            const binding: GovernorC02RestartBinding = Object.freeze({
              taskId,
              sessionId: input.run.sessionId,
              systemdInvocationId,
              gatewayInvocationId: input.run.runId,
              hostDescriptorDigest: input.hostDescriptorDigest,
              modulePlanDigest: input.modulePlanDigest,
              installedToolDigest: prepared.hostToolRegistryDigest,
              sourceHighwater: checkpointTask.authenticatedSourceSequence,
              taskVersion: checkpointTask.taskVersion + 1,
              objectiveRevision: checkpointTask.objectiveRevision,
              planVersion: checkpointTask.planVersion,
              executionGeneration: checkpointTask.executionGeneration,
            });
            recordGovernorC02RestartCheckpoint({
              controller: params.controller,
              taskId,
              run: input.run,
              systemdInvocationId,
              hostDescriptorDigest: input.hostDescriptorDigest,
              modulePlanDigest: input.modulePlanDigest,
              prepared,
              binding,
              toolCallId: observation.toolCallId,
              effectId: evidencePayload.effectId,
              resultDigest: evidencePayload.resultDigest,
              evidenceDigest: evidence.evidenceDigest,
              now: observation.now + 1,
            });
            checkpointPending = true;
            await new Promise<void>((resolve) => {
              if (observation.signal?.aborted) {
                resolve();
                return;
              }
              observation.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          afterTurn(turn) {
            const requestIds = mergeFreshFinnRequestIds({
              value: turn.finnRequestIds,
              complete: turn.finnRequestIdEvidenceComplete,
              freshPrior: runRequestIds,
              durablePrior: durableRequestIds,
            });
            runRequestIds = requestIds.fresh;
            const decision = input.scope.afterTurn(
              Object.freeze({
                ...turn,
                finnRequestIds: requestIds.merged,
                finnRequestIdEvidenceComplete: true,
              }),
            );
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
      } catch (error) {
        activeTasks.delete(taskId);
        failGovernorC02Construction({ scope: input.scope, attestor, error });
      }
    },
    close() {
      closed = true;
    },
  });
}

export const GOVERNOR_C02_HOST_REGISTRATION = Object.freeze({
  id: C02_SIMPLE_EFFICIENCY_ID,
  version: C02_SIMPLE_EFFICIENCY_VERSION,
  bind(host) {
    const capability = createGovernorC02AttestationOwnerCapability({ sign: host.seal });
    const owner = capability.create({
      controller: host.controller,
      store: host.store,
      capabilities: host.capabilities,
      systemdInvocationId: host.systemdInvocationId,
    });
    return Object.freeze({
      wrap: owner.wrap,
      close() {
        owner.close();
        capability.close();
      },
    });
  },
}) satisfies GatewayBehaviorGovernorModuleHostRegistration;
