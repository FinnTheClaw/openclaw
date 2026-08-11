/** Cross-process host-private file lock with an atomically published owner record. */
import crypto from "node:crypto";
import fs from "node:fs";

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeIfPresent(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function publishOwner(lockPath: string, token: string): boolean {
  const candidate = `${lockPath}.${process.pid}.${token}.candidate`;
  try {
    const fd = fs.openSync(candidate, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(candidate, 0o600);
    try {
      // The hard link is atomic and exposes only the fully written record. A
      // crash before this point leaves no lock; a crash after it leaves a
      // complete dead-PID record that the next owner can reap.
      fs.linkSync(candidate, lockPath);
      fs.chmodSync(lockPath, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    removeIfPresent(candidate);
  }
}

function release(lockPath: string, token: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
    if (current.token === token) {
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function withGovernorHostFileLock<T>(lockPath: string, run: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = crypto.randomUUID();
  for (;;) {
    if (publishOwner(lockPath, token)) {
      try {
        return run();
      } finally {
        release(lockPath, token);
      }
    }
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
      const pid = Number(owner.pid);
      if (Number.isSafeInteger(pid) && pid > 0 && !processIsAlive(pid)) {
        fs.unlinkSync(lockPath);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Governor host file-lock acquisition timed out");
    }
    waitSynchronously(LOCK_WAIT_MS);
  }
}
