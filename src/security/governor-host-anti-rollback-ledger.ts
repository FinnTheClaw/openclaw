/**
 * Host-private anti-rollback authority. Its two signed files recover each
 * other, while complete loss beside established primary state fails closed.
 * A full host/OS snapshot rollback remains outside this software trust root.
 */
import { assertGovernorJsonResources } from "../tasks/governor/resource-guard.js";
import { assertGovernorBoundarySafe } from "../tasks/governor/secret-filter.js";
import {
  isValidGovernorLedgerOrdering,
  isValidGovernorTaskFence,
  type GovernorLedgerAppendInput,
  type GovernorLedgerOrdering,
  type GovernorLedgerState,
  type GovernorLedgerTaskFence,
} from "./governor-host-ledger-codec.js";
import { createGovernorLedgerStorage } from "./governor-host-ledger-storage.js";

export type { GovernorLedgerOrdering, GovernorLedgerState, GovernorLedgerTaskFence };

export type GovernorHostAntiRollbackLedger = Readonly<{
  append: (input: GovernorLedgerAppendInput) => GovernorLedgerState;
  state: (kind: GovernorLedgerAppendInput["kind"], key: string) => GovernorLedgerState | null;
}>;

const LEDGERS = new WeakSet<object>();

function validateInput(input: GovernorLedgerAppendInput): void {
  assertGovernorBoundarySafe("log", assertGovernorJsonResources(input));
  if (
    !input.key ||
    !input.bindingDigest ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    (input.ordering !== undefined && !isValidGovernorLedgerOrdering(input.ordering)) ||
    (input.taskFence !== undefined && !isValidGovernorTaskFence(input.taskFence)) ||
    (input.kind === "task") !== (input.taskFence !== undefined)
  ) {
    throw new Error("GOVERNOR_HOST_LEDGER_INPUT_INVALID");
  }
}

/** Called only from trusted host bootstrap. */
export function createGovernorHostAntiRollbackLedger(params: {
  stateDir: string;
  signingKey: string;
  allowInitialization?: boolean;
}): GovernorHostAntiRollbackLedger {
  if (!params.signingKey.trim()) {
    throw new Error("GOVERNOR_HOST_LEDGER_KEY_REQUIRED");
  }
  const storage = createGovernorLedgerStorage({
    stateDir: params.stateDir,
    signingKey: params.signingKey,
    allowInitialization: params.allowInitialization === true,
  });
  const ledger: GovernorHostAntiRollbackLedger = Object.freeze({
    append: (input) => {
      validateInput(input);
      return storage.append(input);
    },
    state: storage.state,
  });
  LEDGERS.add(ledger);
  return ledger;
}

export function isGovernorHostAntiRollbackLedger(value: GovernorHostAntiRollbackLedger): boolean {
  return LEDGERS.has(value);
}
