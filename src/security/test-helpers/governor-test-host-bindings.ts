import { createHostGovernorBroker } from "../governor-host-broker.js";
import { createGovernorHostPersistence } from "../governor-host-persistence.js";
import {
  resolveGovernorSecrets,
  syntheticGovernorSecretsEnvironment,
} from "../governor-host-secrets.js";

/** Test-only complete host graph; production stores never synthesize missing authority. */
export function createGovernorTestBindings(params: { stateDir?: string } = {}) {
  const env = syntheticGovernorSecretsEnvironment(params.stateDir);
  const secrets = resolveGovernorSecrets(env);
  const broker = createHostGovernorBroker({
    secrets,
    persistence: createGovernorHostPersistence({
      env,
      ...params,
      secrets,
      testMode: true,
    }),
  });
  return { ...broker, secrets };
}
