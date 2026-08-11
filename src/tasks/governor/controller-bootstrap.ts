import {
  GovernorCapabilityRegistry,
  type GovernorCapabilityDefinition,
} from "./capability-registry.js";
import { GovernorController } from "./controller.js";
// Feature-gated host construction stays separate from task-loop operations.
import { isBehaviorGovernorEnabled } from "./feature-flag.js";
import { GovernorSqliteStore } from "./store.js";
import { assertGovernorIdentityHmacKeyAvailable } from "./types.js";

export function createGovernorControllerIfEnabled(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  capabilities: readonly GovernorCapabilityDefinition[];
}): GovernorController | null {
  if (!isBehaviorGovernorEnabled(params.env)) return null;
  assertGovernorIdentityHmacKeyAvailable({ ...process.env, ...params.env });
  return new GovernorController(
    new GovernorSqliteStore({ stateDir: params.stateDir }),
    new GovernorCapabilityRegistry(params.capabilities),
  );
}
