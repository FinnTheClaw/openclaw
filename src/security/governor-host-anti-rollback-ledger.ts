/**
 * Host-private V9 anti-rollback journal for governor authorization state.
 *
 * The journal is append-only and hash chained. The separate signed head seals
 * the current chain position and high-water-state digest, so a journal-only
 * truncate fails closed. A full host/OS snapshot of both files remains out of
 * scope without hardware or remote monotonic storage.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalGovernorJson, type GovernorJsonValue } from "../tasks/governor/canonical-json.js";
import { withGovernorHostFileLock } from "./governor-host-file-lock.js";

type LedgerKind = "approval" | "delivery" | "execution" | "ingress" | "memory";
type LedgerStatus =
  | "approved"
  | "cancel_pending"
  | "certified"
  | "claimed"
  | "completed"
  | "consumed"
  | "crashed"
  | "memory_current"
  | "memory_retired"
  | "revoked"
  | "terminated";
type LedgerEntry = Readonly<{
  sequence: number;
  kind: LedgerKind;
  key: string;
  generation: number;
  status: LedgerStatus;
  bindingDigest: string;
  keyId: string;
  keyVersion: 1;
  priorDigest: string;
  digest: string;
  signature: string;
}>;
type LedgerHead = Readonly<{
  sequence: number;
  digest: string;
  highWaterDigest: string;
  keyId: string;
  keyVersion: 1;
  signature: string;
}>;
export type GovernorLedgerState = Readonly<{
  generation: number;
  status: LedgerStatus;
  digest: string;
  bindingDigest: string;
}>;
export type GovernorHostAntiRollbackLedger = {
  readonly append: (input: {
    kind: LedgerKind;
    key: string;
    generation: number;
    status: LedgerStatus;
    bindingDigest: string;
  }) => GovernorLedgerState;
  readonly state: (kind: LedgerKind, key: string) => GovernorLedgerState | null;
};

const LEDGERS = new WeakSet<object>();
const EMPTY_DIGEST = crypto
  .createHash("sha256")
  .update("governor-host-ledger-v9:genesis")
  .digest("hex");
function sha256(value: GovernorJsonValue): string {
  return crypto.createHash("sha256").update(canonicalGovernorJson(value)).digest("hex");
}

function hmac(key: string, value: GovernorJsonValue): string {
  return crypto.createHmac("sha256", key).update(canonicalGovernorJson(value)).digest("hex");
}

function keyId(key: string): string {
  return sha256({ purpose: "governor-host-ledger-key", key });
}

function equal(left: string, right: string): boolean {
  return (
    left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
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

function replaceHead(headPath: string, directory: string, head: LedgerHead): void {
  const temporary = `${headPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(head)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    privateMode(temporary, 0o600);
    fs.renameSync(temporary, headPath);
    privateMode(headPath, 0o600);
    syncFile(headPath);
    syncDirectory(directory);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original failure; startup will fail closed on a missing or stale head.
    }
    throw error;
  }
}

function stateKey(entry: Pick<LedgerEntry, "kind" | "key">): string {
  return `${entry.kind}:${entry.key}`;
}

function statesFor(entries: readonly LedgerEntry[]): Map<string, GovernorLedgerState> {
  const states = new Map<string, GovernorLedgerState>();
  for (const entry of entries) {
    states.set(stateKey(entry), {
      generation: entry.generation,
      status: entry.status,
      digest: entry.digest,
      bindingDigest: entry.bindingDigest,
    });
  }
  return states;
}

function highWaterDigest(entries: readonly LedgerEntry[]): string {
  return sha256(
    [...statesFor(entries)]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, state]) => ({
        key,
        generation: state.generation,
        status: state.status,
        digest: state.digest,
        bindingDigest: state.bindingDigest,
      })),
  );
}

function assertEntry(
  entry: LedgerEntry,
  index: number,
  priorDigest: string,
  signingKey: string,
): void {
  const unsigned = {
    sequence: entry.sequence,
    kind: entry.kind,
    key: entry.key,
    generation: entry.generation,
    status: entry.status,
    bindingDigest: entry.bindingDigest,
    keyId: entry.keyId,
    keyVersion: entry.keyVersion,
    priorDigest: entry.priorDigest,
  };
  if (
    entry.sequence !== index + 1 ||
    !Number.isSafeInteger(entry.generation) ||
    entry.generation < 0 ||
    entry.priorDigest !== priorDigest ||
    entry.keyId !== keyId(signingKey) ||
    entry.keyVersion !== 1 ||
    !equal(entry.digest, sha256(unsigned)) ||
    !equal(entry.signature, hmac(signingKey, { ...unsigned, digest: entry.digest }))
  ) {
    throw new Error("Governor anti-rollback ledger integrity check failed");
  }
}

function parseJournal(journalPath: string, signingKey: string): LedgerEntry[] {
  const raw = fs.readFileSync(journalPath, "utf8");
  if (!raw) {
    return [];
  }
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  const entries: LedgerEntry[] = [];
  let priorDigest = EMPTY_DIGEST;
  for (const [index, line] of lines.entries()) {
    if (!line) {
      throw new Error("Governor anti-rollback ledger has an incomplete tail");
    }
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch (error) {
      throw new Error("Governor anti-rollback ledger integrity check failed", { cause: error });
    }
    assertEntry(entry, index, priorDigest, signingKey);
    entries.push(entry);
    priorDigest = entry.digest;
  }
  return entries;
}

function parseHead(headPath: string, signingKey: string): LedgerHead {
  let head: LedgerHead;
  try {
    head = JSON.parse(fs.readFileSync(headPath, "utf8")) as LedgerHead;
  } catch (error) {
    throw new Error("Governor anti-rollback ledger head is invalid", { cause: error });
  }
  const unsigned = {
    sequence: head.sequence,
    digest: head.digest,
    highWaterDigest: head.highWaterDigest,
    keyId: head.keyId,
    keyVersion: head.keyVersion,
  };
  if (
    head.keyId !== keyId(signingKey) ||
    head.keyVersion !== 1 ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    !equal(head.signature, hmac(signingKey, unsigned))
  ) {
    throw new Error("Governor anti-rollback ledger key mismatch or head tamper");
  }
  return head;
}

function writeInitialFiles(
  journalPath: string,
  headPath: string,
  directory: string,
  key: string,
): void {
  fs.writeFileSync(journalPath, "", { flag: "wx", mode: 0o600 });
  privateMode(journalPath, 0o600);
  syncFile(journalPath);
  replaceHead(headPath, directory, {
    sequence: 0,
    digest: EMPTY_DIGEST,
    highWaterDigest: highWaterDigest([]),
    keyId: keyId(key),
    keyVersion: 1,
    signature: hmac(key, {
      sequence: 0,
      digest: EMPTY_DIGEST,
      highWaterDigest: highWaterDigest([]),
      keyId: keyId(key),
      keyVersion: 1,
    }),
  });
}

function loadEntries(
  journalPath: string,
  headPath: string,
  directory: string,
  signingKey: string,
): LedgerEntry[] {
  const entries = parseJournal(journalPath, signingKey);
  const head = parseHead(headPath, signingKey);
  if (head.sequence > entries.length) {
    throw new Error("Governor anti-rollback ledger head observes a truncate");
  }
  const prefixDigest = head.sequence === 0 ? EMPTY_DIGEST : entries[head.sequence - 1]?.digest;
  if (
    !prefixDigest ||
    !equal(prefixDigest, head.digest) ||
    highWaterDigest(entries.slice(0, head.sequence)) !== head.highWaterDigest
  ) {
    throw new Error("Governor anti-rollback ledger head is invalid or truncated");
  }
  if (entries.length > head.sequence) {
    // A crash after journal fsync and before head replace left a valid signed
    // tail. Forward-seal it; an invalid tail already failed above.
    const last = entries.at(-1);
    if (!last) {
      throw new Error("Governor anti-rollback ledger recovery failed");
    }
    replaceHead(headPath, directory, {
      sequence: entries.length,
      digest: last.digest,
      highWaterDigest: highWaterDigest(entries),
      keyId: keyId(signingKey),
      keyVersion: 1,
      signature: hmac(signingKey, {
        sequence: entries.length,
        digest: last.digest,
        highWaterDigest: highWaterDigest(entries),
        keyId: keyId(signingKey),
        keyVersion: 1,
      }),
    });
  }
  return entries;
}

/** Called only from trusted host bootstrap. */
export function createGovernorHostAntiRollbackLedger(params: {
  stateDir: string;
  signingKey: string;
}): GovernorHostAntiRollbackLedger {
  if (!params.signingKey.trim()) {
    throw new Error("Governor anti-rollback ledger signing key is required");
  }
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
      writeInitialFiles(journalPath, headPath, directory, params.signingKey);
    }
    if (!fs.existsSync(journalPath) || !fs.existsSync(headPath)) {
      throw new Error("Governor anti-rollback ledger is incomplete");
    }
    privateMode(journalPath, 0o600);
    privateMode(headPath, 0o600);
    return loadEntries(journalPath, headPath, directory, params.signingKey);
  });
  const ledger: GovernorHostAntiRollbackLedger = Object.freeze({
    append: (input) =>
      withGovernorHostFileLock(lockPath, () => {
        if (
          !input.key ||
          !input.bindingDigest ||
          !Number.isSafeInteger(input.generation) ||
          input.generation < 0
        ) {
          throw new Error("Governor anti-rollback ledger input is invalid");
        }
        entries = loadEntries(journalPath, headPath, directory, params.signingKey);
        const current = statesFor(entries).get(`${input.kind}:${input.key}`);
        if (current) {
          if (input.generation < current.generation) {
            throw new Error("Governor anti-rollback ledger generation regressed");
          }
          if (input.generation === current.generation) {
            if (input.status === current.status && input.bindingDigest === current.bindingDigest) {
              return current;
            }
            const validIngressTransition =
              input.kind === "ingress" &&
              current.status === "claimed" &&
              (input.status === "consumed" || input.status === "revoked");
            if (!validIngressTransition) {
              throw new Error("Governor anti-rollback ledger binding conflicts at generation");
            }
          }
        }
        const unsigned = {
          sequence: entries.length + 1,
          ...input,
          keyId: keyId(params.signingKey),
          keyVersion: 1 as const,
          priorDigest: entries.at(-1)?.digest ?? EMPTY_DIGEST,
        };
        const entry: LedgerEntry = {
          ...unsigned,
          digest: sha256(unsigned),
          signature: hmac(params.signingKey, { ...unsigned, digest: sha256(unsigned) }),
        };
        const fd = fs.openSync(journalPath, "a", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        privateMode(journalPath, 0o600);
        const nextEntries = [...entries, entry];
        const nextHead: LedgerHead = {
          sequence: nextEntries.length,
          digest: entry.digest,
          highWaterDigest: highWaterDigest(nextEntries),
          keyId: keyId(params.signingKey),
          keyVersion: 1,
          signature: hmac(params.signingKey, {
            sequence: nextEntries.length,
            digest: entry.digest,
            highWaterDigest: highWaterDigest(nextEntries),
            keyId: keyId(params.signingKey),
            keyVersion: 1,
          }),
        };
        replaceHead(headPath, directory, nextHead);
        entries = nextEntries;
        return {
          generation: entry.generation,
          status: entry.status,
          digest: entry.digest,
          bindingDigest: entry.bindingDigest,
        };
      }),
    state: (kind, key) =>
      withGovernorHostFileLock(lockPath, () => {
        entries = loadEntries(journalPath, headPath, directory, params.signingKey);
        return statesFor(entries).get(`${kind}:${key}`) ?? null;
      }),
  });
  LEDGERS.add(ledger);
  return ledger;
}

export function isGovernorHostAntiRollbackLedger(value: GovernorHostAntiRollbackLedger): boolean {
  return LEDGERS.has(value);
}
