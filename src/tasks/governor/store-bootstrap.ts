// Constructs the explicit, feature-enabled governor store dependency graph.
import {
  createGovernorTestHostBindings,
  isTrustedGovernorReceiptResolver,
  type GovernorTrustedApprovalResolver,
  type GovernorTrustedDeliveryResolver,
  type GovernorTrustedMemoryAuthority,
  type GovernorTrustedPhysicalExecutionCoordinator,
  type GovernorTrustedReceiptResolver,
  type GovernorTrustedTaskAuthority,
} from "../../security/governor-host-readonly.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { GovernorActionIntentStore } from "./action-intent-store.js";
import { GovernorApprovalGrantStore } from "./approval-store.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { GovernorCheckpointStore } from "./checkpoint-store.js";
import { GovernorDeliveryCertificationStore } from "./delivery-certification-store.js";
import { GovernorExternalChildRunStore } from "./external-child-runs.js";
import { GovernorFanoutStore } from "./fanout.js";
import { GovernorMemorySubsystem } from "./memory-subsystem.js";
import { GovernorOutboxStore } from "./outbox-store.js";
import { initializeGovernorStateSchema } from "./state-schema.js";
import { GovernorEvidenceAdmissionStore } from "./store-evidence-admission.js";
import { GovernorStoreQueries } from "./store-queries.js";
import { GovernorTaskAuthorityStore } from "./task-authority.js";
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
  memoryAuthority?: GovernorTrustedMemoryAuthority;
  taskAuthority?: GovernorTrustedTaskAuthority;
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
    !params.memoryAuthority ||
    !params.taskAuthority ||
    !params.secrets
      ? createGovernorTestHostBindings({ stateDir: params.stateDir })
      : undefined;
  const receiptResolver = params.receiptResolver ?? testBroker?.resolver;
  const approvalResolver = params.approvalResolver ?? testBroker?.approvalResolver;
  const deliveryResolver = params.deliveryResolver ?? testBroker?.deliveryResolver;
  const physicalExecutionCoordinator =
    params.physicalExecutionCoordinator ?? testBroker?.physicalExecutionCoordinator;
  const memoryAuthority = params.memoryAuthority ?? testBroker?.memoryAuthority;
  const taskAuthority = params.taskAuthority ?? testBroker?.taskAuthority;
  const secrets = params.secrets ?? testBroker?.secrets;
  if (!receiptResolver || !isTrustedGovernorReceiptResolver(receiptResolver)) {
    throw new Error("Governor store requires a trusted host receipt resolver");
  }
  if (
    !approvalResolver ||
    !deliveryResolver ||
    !physicalExecutionCoordinator ||
    !memoryAuthority ||
    !taskAuthority ||
    !secrets
  ) {
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
  const tasks = new GovernorTaskAuthorityStore(taskAuthority);
  tasks.reconcilePrimary(openOpenClawStateDatabase(options).db);
  const evidenceAdmissions = new GovernorEvidenceAdmissionStore({
    receiptResolver,
    identity: secrets.identity,
    evidenceAdmissionKey: secrets.evidenceAdmissionKey,
    evidenceAdmissionKeyId: secrets.evidenceAdmissionKeyId,
  });
  const queries = new GovernorStoreQueries(options, tasks, (evidence) =>
    evidenceAdmissions.verify(evidence),
  );
  const approvals = new GovernorApprovalGrantStore({ options, approvalResolver });
  const fanout = new GovernorFanoutStore({
    options,
    physicalExecutionCoordinator,
    receiptResolver,
    taskAuthority: tasks,
  });
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
      memoryAuthority,
      taskAuthority: tasks,
    }),
    capabilities,
    actionIntents: new GovernorActionIntentStore({
      options,
      approvals,
      capabilities,
      identity: secrets.identity,
      receiptResolver,
      taskAuthority: tasks,
    }),
    approvals,
    deliveryCertifications: new GovernorDeliveryCertificationStore({
      options,
      deliveryResolver,
    }),
    checkpoints: new GovernorCheckpointStore({ options }),
    outbox: new GovernorOutboxStore({ options, taskAuthority: tasks }),
    tasks,
    fanout,
    children: new GovernorExternalChildRunStore({ fanout, receiptResolver }),
  };
}
