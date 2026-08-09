/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentModelRouteSelection,
  resolveSubagentModelOverrideAllowed,
  resolveSubagentSpawnModelSelection,
} from "./model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

/** Resolves the effective subagent run timeout from per-call override or config default. */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

/**
 * Reconcile a disallowed raw model override with an administrator-approved
 * route that selects the exact same model.
 *
 * Local models sometimes emit `model` even after being told to use
 * `modelRoute`. Silently discarding that field can move specialty work onto
 * the default route. Mapping only exact configured matches preserves the
 * administrator boundary while making the accepted result deterministic.
 */
function resolveConfiguredRouteFromDisallowedModelOverride(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  modelOverride?: string;
  modelRoute?: string;
}): string | undefined {
  const requestedModel = params.modelOverride?.trim();
  if (
    !requestedModel ||
    params.modelRoute?.trim() ||
    resolveSubagentModelOverrideAllowed({
      cfg: params.cfg,
      agentId: params.targetAgentId,
    })
  ) {
    return undefined;
  }
  const defaultSelection = resolveSubagentModelRouteSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
  });
  const matches = defaultSelection.availableRoutes
    .map((route) =>
      resolveSubagentModelRouteSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        modelRoute: route,
      }),
    )
    .filter((selection) => selection.model?.trim() === requestedModel);
  return (
    matches.find((selection) => selection.route === defaultSelection.route)?.route ??
    matches[0]?.route
  );
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  modelRoute?: string;
  hasImageAttachments?: boolean;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}) {
  const requestedRoute =
    params.modelRoute?.trim() || resolveConfiguredRouteFromDisallowedModelOverride(params);
  let routeSelection = resolveSubagentModelRouteSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelRoute: requestedRoute ?? (params.hasImageAttachments ? "vision" : undefined),
  });
  if (!requestedRoute && params.hasImageAttachments && !routeSelection.model) {
    routeSelection = resolveSubagentModelRouteSelection({
      cfg: params.cfg,
      agentId: params.targetAgentId,
    });
  }
  if (requestedRoute && routeSelection.requestedRoute && !routeSelection.model) {
    const available =
      routeSelection.availableRoutes.length > 0
        ? routeSelection.availableRoutes.join(", ")
        : "(none configured)";
    return {
      status: "error" as const,
      resolvedModel: "",
      error: `Unknown or unconfigured subagent model route "${routeSelection.requestedRoute}". Available routes: ${available}.`,
    };
  }
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
    modelRoute: routeSelection.route,
  });

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const modelOverrideSource =
    params.modelOverride?.trim() &&
    resolveSubagentModelOverrideAllowed({ cfg: params.cfg, agentId: params.targetAgentId })
      ? "user"
      : "auto";
  const hasConfiguredAutoModel =
    modelOverrideSource === "auto" &&
    Boolean(
      resolveSubagentConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        modelRoute: routeSelection.route,
      }),
    );
  const configuredModelRef = hasConfiguredAutoModel ? splitModelRef(resolvedModel) : undefined;
  const modelOrigin = configuredModelRef?.model
    ? {
        provider:
          configuredModelRef.provider ??
          resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: params.targetAgentId,
          }).provider,
        model: configuredModelRef.model,
      }
    : undefined;

  return {
    status: "ok" as const,
    resolvedModel,
    modelRoute: modelOverrideSource === "auto" ? routeSelection.route : undefined,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource,
            ...(modelOrigin
              ? {
                  // Config-selected models are session overrides, not legacy fallback residue.
                  // Self-origin metadata keeps cleanup from discarding them before first use.
                  modelOverrideFallbackOriginProvider: modelOrigin.provider,
                  modelOverrideFallbackOriginModel: modelOrigin.model,
                }
              : {}),
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
    },
  };
}
