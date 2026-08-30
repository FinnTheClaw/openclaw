import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedRunTrigger } from "./run/params.js";

export type AtomicFinalResponseMode = "shadow" | "enforce";

type AtomicFinalResponseInput = Readonly<{
  trigger?: EmbeddedRunTrigger;
  spawnedBy?: string | null;
  modelRun?: boolean;
  disableTools?: boolean;
  clientToolCount: number;
  toolsAllow?: readonly string[];
  config?: OpenClawConfig;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  resolvedThinkLevel: ThinkLevel;
}>;

export type AtomicFinalResponsePolicy = Readonly<{
  thinkLevel: ThinkLevel;
  continuationRetryLimit: 0;
  requireVisibleFinal: true;
}>;

let active: Readonly<{ token: object; mode: AtomicFinalResponseMode }> | undefined;

function explicitlyDeniesAllTools(input: AtomicFinalResponseInput): boolean {
  if (input.disableTools === true) {
    return true;
  }
  return input.config?.tools?.deny?.includes("*") === true;
}

function isDirectAtomicTurn(input: AtomicFinalResponseInput): boolean {
  const trigger = input.trigger ?? "user";
  const governor = input.config?.experimental?.behaviorGovernor;
  const legacyPlanAuthority = Boolean(governor && "enabled" in governor && governor.enabled);
  return (
    (trigger === "user" || trigger === "manual") &&
    !input.spawnedBy &&
    input.modelRun !== true &&
    input.clientToolCount === 0 &&
    (input.toolsAllow?.length ?? 0) === 0 &&
    explicitlyDeniesAllTools(input) &&
    !legacyPlanAuthority &&
    input.silentExpected !== true &&
    input.allowEmptyAssistantReplyAsSilent !== true
  );
}

function suppressHighThinking(level: ThinkLevel): ThinkLevel {
  return ["high", "xhigh", "adaptive", "max", "ultra"].includes(level) ? "off" : level;
}

/** Installs the C06b final-response policy without creating a second retry owner. */
export function installAtomicFinalResponsePolicy(mode: AtomicFinalResponseMode): {
  close: () => void;
} {
  if (active) {
    throw new Error("GOVERNOR_C06B_ATOMIC_FINAL_ALREADY_ACTIVE");
  }
  const token = {};
  active = Object.freeze({ token, mode });
  return Object.freeze({
    close: () => {
      if (active?.token === token) {
        active = undefined;
      }
    },
  });
}

/** Returns an enforce-only override for explicit direct no-tool turns. */
export function resolveAtomicFinalResponsePolicy(
  input: AtomicFinalResponseInput,
): AtomicFinalResponsePolicy | undefined {
  if (active?.mode !== "enforce" || !isDirectAtomicTurn(input)) {
    return undefined;
  }
  return Object.freeze({
    thinkLevel: suppressHighThinking(input.resolvedThinkLevel),
    continuationRetryLimit: 0,
    requireVisibleFinal: true,
  });
}
