import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { GovernorCommitResult } from "./store-types.js";
import type { GovernorTaskAuthorityStore } from "./task-authority.js";

export function runRecoverableTaskWrite(
  options: OpenClawStateDatabaseOptions,
  tasks: GovernorTaskAuthorityStore,
  operation: (database: OpenClawStateDatabase) => GovernorCommitResult,
): GovernorCommitResult {
  let result: GovernorCommitResult;
  try {
    result = runOpenClawStateWriteTransaction(operation, options);
  } catch (error) {
    runOpenClawStateWriteTransaction(({ db }) => tasks.reconcilePrimary(db), options);
    throw error;
  }
  if (!result.applied) {
    runOpenClawStateWriteTransaction(({ db }) => tasks.reconcilePrimary(db), options);
  }
  return result;
}
