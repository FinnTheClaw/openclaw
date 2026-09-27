import type { GovernorSqliteStore } from "../tasks/governor/store.js";
import type { GovernorTaskId } from "../tasks/governor/types.js";
import {
  validateGovernorC02Attestation,
  type GovernorC02SignedAttestation,
  type createGovernorC02AttestationAuthority,
} from "./governor-c02-runtime-attestation.js";
import {
  assertGovernorC02PreparedRun,
  type GovernorC02PreparedRun,
} from "./governor-c02-simple-efficiency-policy.js";

export function createGovernorC02AttestationOwner(params: {
  store: GovernorSqliteStore;
  authority: ReturnType<typeof createGovernorC02AttestationAuthority>;
}) {
  const taskByRun = new WeakMap<object, GovernorTaskId>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new Error("GOVERNOR_C02_ATTESTATION_OWNER_CLOSED");
    }
  };
  return Object.freeze({
    bindRun(run: GovernorC02PreparedRun, taskId: GovernorTaskId): void {
      assertOpen();
      assertGovernorC02PreparedRun(run);
      if (taskByRun.has(run)) {
        throw new Error("GOVERNOR_C02_ATTESTATION_RUN_ALREADY_BOUND");
      }
      taskByRun.set(run, taskId);
    },
    issue(paramsInput: {
      run: GovernorC02PreparedRun;
      artifactDigest: string;
      issuedAt: number;
    }): GovernorC02SignedAttestation {
      assertOpen();
      assertGovernorC02PreparedRun(paramsInput.run);
      const taskId = taskByRun.get(paramsInput.run);
      if (!taskId) {
        throw new Error("GOVERNOR_C02_ATTESTATION_RUN_NOT_BOUND");
      }
      const candidate = validateGovernorC02Attestation({
        run: paramsInput.run,
        snapshot: params.store.readC02AttestationSnapshot(taskId),
        artifactDigest: paramsInput.artifactDigest,
        issuedAt: paramsInput.issuedAt,
        opaqueActionTarget: (value) => params.store.opaqueReference("action-target", value),
      });
      return params.authority.issue(candidate);
    },
    verify(attestation: GovernorC02SignedAttestation, installedArtifactDigest: string): boolean {
      assertOpen();
      return params.authority.verify(attestation, installedArtifactDigest);
    },
    close(): void {
      closed = true;
    },
  });
}
