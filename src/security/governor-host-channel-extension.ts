/**
 * Channel delivery and authenticated owner ingress remain outside the
 * governed-run core. This compatibility boundary is intentionally separate so
 * a descriptor must opt into channel authority in a later slice.
 */
export {
  createGovernorHostRuntimeAdapterIfEnabled,
  createGovernorHostRuntimeBindings,
  createGovernorHostRuntimeIfEnabled,
  type GovernorHostIntegrationConfiguration,
  type GovernorHostRuntime,
} from "./governor-host-bootstrap.js";
