import type { GatewayBehaviorGovernorModuleHostRegistration } from "../gateway/behavior-governor-module-host-registration.js";
import { createGovernorTaskId } from "../tasks/governor/types.js";
import type { GovernorAgentLoopRunScope } from "./governor-agent-loop-types.js";
import { parseC02EvaluationSession } from "./governor-c02-evaluation.js";
import {
  C02_SIMPLE_EFFICIENCY_ID,
  C02_SIMPLE_EFFICIENCY_VERSION,
} from "./governor-c02-simple-efficiency-policy.js";

const EVENT_TYPE = "runtime_tool_observed" as const;
const RESTART_REQUIRED = "c02_restart_required";
const RESTART_RESUMED = "c02_restart_resumed";

type RestartPayload = Readonly<{
  kind: typeof RESTART_REQUIRED | typeof RESTART_RESUMED;
  moduleId: typeof C02_SIMPLE_EFFICIENCY_ID;
  processInstanceId: string;
  requiredProcessInstanceId?: string;
}>;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function restartPayload(value: unknown): RestartPayload | undefined {
  if (
    !isObject(value) ||
    (value.kind !== RESTART_REQUIRED && value.kind !== RESTART_RESUMED) ||
    value.moduleId !== C02_SIMPLE_EFFICIENCY_ID ||
    typeof value.processInstanceId !== "string" ||
    !value.processInstanceId.trim()
  ) {
    return undefined;
  }
  if (
    value.requiredProcessInstanceId !== undefined &&
    (typeof value.requiredProcessInstanceId !== "string" || !value.requiredProcessInstanceId.trim())
  ) {
    return undefined;
  }
  return value as RestartPayload;
}

export const C02_RESTART_REGISTRATION: GatewayBehaviorGovernorModuleHostRegistration =
  Object.freeze({
    id: C02_SIMPLE_EFFICIENCY_ID,
    version: C02_SIMPLE_EFFICIENCY_VERSION,
    bind(host) {
      if (!host.processInstanceId.trim()) {
        throw new Error("C02_PROCESS_INSTANCE_REQUIRED");
      }
      const issued = new Set<GovernorAgentLoopRunScope>();
      let closed = false;
      return Object.freeze({
        wrap(input) {
          if (closed) {
            throw new Error("C02_RESTART_GUARD_CLOSED");
          }
          const evaluation = parseC02EvaluationSession(input.run.sessionKey);
          if (!evaluation?.restartAfterObserveB) {
            return input.scope;
          }
          const taskId = createGovernorTaskId(input.scope.taskId);
          const restartHistory = (): readonly RestartPayload[] =>
            host.store
              .listEvents(taskId)
              .filter((event) => event.eventType === EVENT_TYPE)
              .map((event) => restartPayload(event.payload))
              .filter((value): value is RestartPayload => value !== undefined);
          const latestMarker = (): RestartPayload | undefined =>
            restartHistory().findLast((value) => value.kind === RESTART_REQUIRED);
          const restartPending = (): boolean =>
            latestMarker()?.processInstanceId === host.processInstanceId;
          const prior = restartHistory();
          const marker = prior.findLast((value) => value.kind === RESTART_REQUIRED);
          if (
            marker &&
            marker.processInstanceId !== host.processInstanceId &&
            !prior.some(
              (value) =>
                value.kind === RESTART_RESUMED &&
                value.processInstanceId === host.processInstanceId &&
                value.requiredProcessInstanceId === marker.processInstanceId,
            )
          ) {
            host.controller.recordRuntimeEvent({
              taskId,
              eventType: EVENT_TYPE,
              payload: {
                kind: RESTART_RESUMED,
                moduleId: C02_SIMPLE_EFFICIENCY_ID,
                processInstanceId: host.processInstanceId,
                requiredProcessInstanceId: marker.processInstanceId,
              },
              now: input.run.now,
            });
          }
          const betaTickets = new WeakSet<object>();
          const pendingResolvers = new Set<() => void>();
          let disposed = false;
          const releasePending = (): void => {
            for (const resolve of pendingResolvers) {
              resolve();
            }
            pendingResolvers.clear();
          };
          const scope: GovernorAgentLoopRunScope = Object.freeze({
            ...input.scope,
            get disposition() {
              return restartPending() ? "checkpoint_pending" : input.scope.disposition;
            },
            beforeTool(request) {
              if (restartPending()) {
                return { kind: "block", reasonCode: "C02_RESTART_REQUIRED" };
              }
              const decision = input.scope.beforeTool(request);
              if (
                decision.kind === "allow" &&
                decision.ticket &&
                request.toolName === "read" &&
                isObject(request.args) &&
                request.args.path === evaluation.betaPath
              ) {
                host.controller.recordRuntimeEvent({
                  taskId,
                  eventType: EVENT_TYPE,
                  payload: {
                    kind: RESTART_REQUIRED,
                    moduleId: C02_SIMPLE_EFFICIENCY_ID,
                    processInstanceId: host.processInstanceId,
                  },
                  now: request.now,
                });
                betaTickets.add(decision.ticket.opaque);
              }
              return decision;
            },
            async afterTool(observation) {
              const ticket = observation.ticket?.opaque;
              const observedB = ticket ? betaTickets.has(ticket) : false;
              await input.scope.afterTool(observation);
              if (ticket) {
                betaTickets.delete(ticket);
              }
              if (observation.isError || !observedB) {
                return;
              }
              const signal = observation.signal;
              if (!signal) {
                throw new Error("C02_RESTART_SIGNAL_REQUIRED");
              }
              if (signal.aborted) {
                return;
              }
              await new Promise<void>((resolve) => {
                const settle = (): void => {
                  pendingResolvers.delete(settle);
                  signal.removeEventListener("abort", settle);
                  resolve();
                };
                pendingResolvers.add(settle);
                signal.addEventListener("abort", settle, { once: true });
              });
            },
            afterTurn(turn) {
              return restartPending()
                ? { kind: "interrupt", reasonCode: "C02_RESTART_REQUIRED" }
                : input.scope.afterTurn(turn);
            },
            dispose() {
              if (disposed) {
                return;
              }
              disposed = true;
              releasePending();
              try {
                input.scope.dispose();
              } finally {
                issued.delete(scope);
              }
            },
          });
          issued.add(scope);
          return scope;
        },
        close() {
          if (closed) {
            return;
          }
          const errors: unknown[] = [];
          for (const scope of [...issued].toReversed()) {
            try {
              scope.dispose();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0 || issued.size > 0) {
            throw new AggregateError(errors, "C02_RESTART_GUARD_CLOSE_FAILED");
          }
          closed = true;
        },
      });
    },
  });
