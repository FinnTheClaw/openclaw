// Constructs the explicit, feature-enabled governor store dependency graph.
import {
  createGovernorTestHostBindings,
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedApprovalResolver,
  type GovernorTrustedDeliveryResolver,
  type GovernorTrustedPhysicalExecutionCoordinator,
  type GovernorTrustedReceiptResolver,
} from "../../security/governor-host-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { GovernorActionIntentStore } from "./action-intent-store.js";
import { GovernorApprovalGrantStore } from "./approval-store.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorCheckpointStore } from "./checkpoint-store.js";
import { GovernorDeliveryCertificationStore } from "./delivery-certification-store.js";
import { GovernorFanoutStore } from "./fanout.js";
import { GovernorMemorySubsystem } from "./memory-subsystem.js";
import { GovernorOutboxStore } from "./outbox-store.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import { GovernorStoreQueries } from "./store-queries.js";
import type { GovernorIdentityContext } from "./types.js";

export type GovernorStoreSecrets = Readonly<{
  identity: GovernorIdentityContext;
  evidenceAdmissionKey: string;
  evidenceAdmissionKeyId: string;
}>;

export type GovernorSqliteStoreParams = {
  stateDir?: string;
  receiptResolver?: GovernorTrustedReceiptResolver;
  approvalResolver?: GovernorTrustedApprovalResolver;
  deliveryResolver?: GovernorTrustedDeliveryResolver;
  physicalExecutionCoordinator?: GovernorTrustedPhysicalExecutionCoordinator;
  secrets?: GovernorStoreSecrets;
  stateEnv?: NodeJS.ProcessEnv;
  capabilities?: GovernorCapabilityRegistry;
};

export function createGovernorStoreDependencies(params: GovernorSqliteStoreParams) {
  const testBroker =
    !params.receiptResolver ||
    !params.approvalResolver ||
    !params.deliveryResolver ||
    !params.physicalExecutionCoordinator ||
    !params.secrets
      ? createGovernorTestHostBindings({ stateDir: params.stateDir })
      : undefined;
  const receiptResolver = params.receiptResolver ?? testBroker?.resolver;
  const approvalResolver = params.approvalResolver ?? testBroker?.approvalResolver;
  const deliveryResolver = params.deliveryResolver ?? testBroker?.deliveryResolver;
  const physicalExecutionCoordinator =
    params.physicalExecutionCoordinator ?? testBroker?.physicalExecutionCoordinator;
  const secrets = params.secrets ?? testBroker?.secrets;
  if (!receiptResolver || !isTrustedGovernorReceiptResolver(receiptResolver)) {
    throw new Error("Governor store requires a trusted host receipt resolver");
  }
  if (!approvalResolver || !deliveryResolver || !physicalExecutionCoordinator || !secrets) {
    throw new Error("Governor store requires explicit host bindings and secrets");
  }
  const options: OpenClawStateDatabaseOptions = {
    env: {
      ...params.stateEnv,
      ...(params.stateDir ? { OPENCLAW_STATE_DIR: params.stateDir } : {}),
    },
  };
  const capabilities = params.capabilities ?? new GovernorCapabilityRegistry([]);
  initializeGovernorStateSchema(options);
  const evidenceAdmissions = new GovernorEvidenceAdmissionStore({
    receiptResolver,
    identity: secrets.identity,
    evidenceAdmissionKey: secrets.evidenceAdmissionKey,
    evidenceAdmissionKeyId: secrets.evidenceAdmissionKeyId,
  });
  const queries = new GovernorStoreQueries(options, (evidence) =>
    evidenceAdmissions.verify(evidence),
  );
  const approvals = new GovernorApprovalGrantStore({ options, approvalResolver });
  return {
    options,
    identity: secrets.identity,
    evidenceAdmissions,
    queries,
    memory: new GovernorMemorySubsystem({
      options,
      identity: secrets.identity,
      evidenceAdmissions,
      queries,
    }),
    capabilities,
    actionIntents: new GovernorActionIntentStore({
      options,
      approvals,
      capabilities,
      identity: secrets.identity,
      receiptResolver,
    }),
    approvals,
    deliveryCertifications: new GovernorDeliveryCertificationStore({
      options,
      deliveryResolver,
    }),
    checkpoints: new GovernorCheckpointStore({ options }),
    outbox: new GovernorOutboxStore({ options }),
    fanout: new GovernorFanoutStore({
      options,
      physicalExecutionCoordinator,
      receiptResolver,
    }),
  };
}
