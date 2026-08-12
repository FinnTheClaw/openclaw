// Crash-safe two-copy storage for the host anti-rollback ledger.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withGovernorHostFileLock } from "./governor-host-file-lock.js";
import {
  GOVERNOR_LEDGER_EMPTY_DIGEST,
  createGovernorLedgerEntry,
  governorLedgerHighWaterDigest,
  governorLedgerStates,
  makeGovernorLedgerHead,
  parseGovernorLedgerHead,
  parseGovernorLedgerJournal,
  sameGovernorLedgerMetadata,
  type GovernorLedgerAppendInput,
  type GovernorLedgerEntry,
  type GovernorLedgerHead,
  type GovernorLedgerKind,
  type GovernorLedgerState,
} from "./governor-host-ledger-codec.js";

export type GovernorLedgerStorage = Readonly<{
  append: (input: GovernorLedgerAppendInput) => GovernorLedgerState;
  state: (kind: GovernorLedgerKind, key: string) => GovernorLedgerState | null;
}>;

type LedgerFileFingerprint = Readonly<{ journal: string; head: string }>;

function fileFingerprint(target: string): string {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function ledgerFileFingerprint(journalPath: string, headPath: string): LedgerFileFingerprint {
  return { journal: fileFingerprint(journalPath), head: fileFingerprint(headPath) };
}

function sameFileFingerprint(left: LedgerFileFingerprint, right: LedgerFileFingerprint): boolean {
  return left.journal === right.journal && left.head === right.head;
}

function privateMode(target: string, mode: number): void {
  fs.chmodSync(target, mode);
}

function syncFile(target: string): void {
  const fd = fs.openSync(target, "r");
  try {
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM"]).has(code ?? "")) {
        throw error;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(target: string): void {
  try {
    syncFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM"]).has(code ?? "")) {
      throw error;
    }
  }
}

function replaceFile(target: string, directory: string, content: string): void {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    privateMode(temporary, 0o600);
    fs.renameSync(temporary, target);
    privateMode(target, 0o600);
    syncFile(target);
    syncDirectory(directory);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original durable-write failure.
    }
    throw error;
  }
}

function replaceHead(target: string, directory: string, head: GovernorLedgerHead): void {
  replaceFile(target, directory, `${JSON.stringify(head)}\n`);
}

function replaceJournal(
  target: string,
  directory: string,
  entries: readonly GovernorLedgerEntry[],
): void {
  replaceFile(
    target,
    directory,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
  );
}

function loadJournal(target: string, signingKey: string): GovernorLedgerEntry[] {
  return parseGovernorLedgerJournal(fs.readFileSync(target, "utf8"), signingKey);
}

function loadHead(target: string, signingKey: string): GovernorLedgerHead {
  return parseGovernorLedgerHead(fs.readFileSync(target, "utf8"), signingKey);
}

function loadAndRepair(params: {
  journalPath: string;
  headPath: string;
  directory: string;
  signingKey: string;
}): GovernorLedgerEntry[] {
  let entries: GovernorLedgerEntry[] | null = null;
  let head: GovernorLedgerHead | null = null;
  try {
    entries = loadJournal(params.journalPath, params.signingKey);
  } catch {
    // The independently signed head snapshot may repair this copy.
  }
  try {
    head = loadHead(params.headPath, params.signingKey);
  } catch {
    // The signed journal may repair this copy.
  }
  if (!entries && head?.entries) {
    replaceJournal(params.journalPath, params.directory, head.entries);
    return [...head.entries];
  }
  if (entries && !head) {
    replaceHead(
      params.headPath,
      params.directory,
      makeGovernorLedgerHead(entries, params.signingKey),
    );
    return entries;
  }
  if (!entries || !head) {
    throw new Error("GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED");
  }
  if (head.sequence > entries.length) {
    if (!head.entries) {
      throw new Error("GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED");
    }
    replaceJournal(params.journalPath, params.directory, head.entries);
    return [...head.entries];
  }
  const prefixDigest =
    head.sequence === 0 ? GOVERNOR_LEDGER_EMPTY_DIGEST : entries[head.sequence - 1]?.digest;
  if (
    !prefixDigest ||
    prefixDigest !== head.digest ||
    governorLedgerHighWaterDigest(entries.slice(0, head.sequence)) !== head.highWaterDigest
  ) {
    throw new Error("GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED");
  }
  if (entries.length > head.sequence || !head.entries) {
    replaceHead(
      params.headPath,
      params.directory,
      makeGovernorLedgerHead(entries, params.signingKey),
    );
  }
  return entries;
}

function appendJournal(target: string, entry: GovernorLedgerEntry): void {
  const fd = fs.openSync(target, "a", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  privateMode(target, 0o600);
}

function validSameGenerationTransition(
  input: GovernorLedgerAppendInput,
  current: GovernorLedgerState,
): boolean {
  return (
    (input.kind === "ingress" &&
      current.status === "claimed" &&
      (input.status === "consumed" || input.status === "revoked")) ||
    (input.kind === "task" &&
      current.status === "task_intent" &&
      input.status === "task_current" &&
      input.bindingDigest === current.bindingDigest)
  );
}

export function createGovernorLedgerStorage(params: {
  stateDir: string;
  signingKey: string;
  allowInitialization: boolean;
}): GovernorLedgerStorage {
  const directory = path.join(params.stateDir, "host-governor");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateMode(directory, 0o700);
  const journalPath = path.join(directory, "anti-rollback-v1.journal");
  const headPath = path.join(directory, "anti-rollback-v1.head");
  const lockPath = path.join(directory, "anti-rollback-v1.lock");
  let entries = withGovernorHostFileLock(lockPath, () => {
    const journalExists = fs.existsSync(journalPath);
    const headExists = fs.existsSync(headPath);
    if (!journalExists && !headExists) {
      if (!params.allowInitialization) {
        throw new Error("GOVERNOR_HOST_AUTHORITY_RECOVERY_REQUIRED");
      }
      replaceJournal(journalPath, directory, []);
      replaceHead(headPath, directory, makeGovernorLedgerHead([], params.signingKey));
    }
    return loadAndRepair({ journalPath, headPath, directory, signingKey: params.signingKey });
  });
  let states = governorLedgerStates(entries);
  let fingerprint = ledgerFileFingerprint(journalPath, headPath);
  const refresh = () => {
    const observed = ledgerFileFingerprint(journalPath, headPath);
    if (sameFileFingerprint(observed, fingerprint)) {
      return;
    }
    entries = loadAndRepair({ journalPath, headPath, directory, signingKey: params.signingKey });
    states = governorLedgerStates(entries);
    fingerprint = ledgerFileFingerprint(journalPath, headPath);
  };
  return Object.freeze({
    append: (input) =>
      withGovernorHostFileLock(lockPath, () => {
        refresh();
        const stateKey = `${input.kind}:${input.key}`;
        const current = states.get(stateKey);
        if (current) {
          if (input.generation < current.generation) {
            throw new Error("GOVERNOR_HOST_LEDGER_GENERATION_REGRESSION");
          }
          if (input.generation === current.generation) {
            if (input.status === current.status && input.bindingDigest === current.bindingDigest) {
              if (!sameGovernorLedgerMetadata(input, current)) {
                throw new Error("GOVERNOR_HOST_LEDGER_METADATA_CONFLICT");
              }
              return current;
            }
            if (!validSameGenerationTransition(input, current)) {
              throw new Error("GOVERNOR_HOST_LEDGER_BINDING_CONFLICT");
            }
          }
        }
        const entry = createGovernorLedgerEntry(entries, input, params.signingKey);
        appendJournal(journalPath, entry);
        const next = [...entries, entry];
        replaceHead(headPath, directory, makeGovernorLedgerHead(next, params.signingKey));
        entries = next;
        const nextState = governorLedgerStates([entry]).get(stateKey)!;
        states.set(stateKey, nextState);
        fingerprint = ledgerFileFingerprint(journalPath, headPath);
        return nextState;
      }),
    state: (kind, key) =>
      withGovernorHostFileLock(lockPath, () => {
        refresh();
        return states.get(`${kind}:${key}`) ?? null;
      }),
  });
}
