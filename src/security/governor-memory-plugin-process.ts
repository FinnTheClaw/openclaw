import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
  type C07PluginHostFrame,
  type C07PluginJson,
  parseC07PluginHostFrame,
  parseC07PluginWorkerFrame,
} from "./governor-memory-plugin-process-protocol.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;
const INVOCATION_TIMEOUT_MS = 30_000;

export type C07PluginProcessAttestation = Readonly<{
  pid: number;
  uid: number;
  gid: number;
  groups: readonly number[];
  bootEpoch: string;
  implementationDigest: string;
}>;

export type C07PluginProcess = Readonly<{
  attestation: C07PluginProcessAttestation;
  invoke(payload: C07PluginJson): Promise<C07PluginJson>;
  close(): Promise<void>;
}>;

type PendingInvocation = Readonly<{
  sequence: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve(value: C07PluginJson): void;
  reject(error: Error): void;
}>;

function randomDigest(): string {
  return randomBytes(32).toString("hex");
}

function assertUnixIdentity(
  pluginUid: number,
  pluginGid: number,
): {
  supervisorUid: number;
  supervisorGid: number;
} {
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    !Number.isSafeInteger(pluginUid) ||
    pluginUid <= 0 ||
    !Number.isSafeInteger(pluginGid) ||
    pluginGid <= 0
  ) {
    throw new Error("C07_PLUGIN_PROCESS_PLATFORM_UNSUPPORTED");
  }
  const supervisorUid = process.getuid();
  const supervisorGid = process.getgid();
  if (supervisorUid === pluginUid) {
    throw new Error("C07_PLUGIN_PROCESS_IDENTITY_NOT_SEPARATE");
  }
  if (supervisorUid !== 0) {
    throw new Error("C07_PLUGIN_PROCESS_PRIVILEGE_REQUIRED");
  }
  return { supervisorUid, supervisorGid };
}

function assertProtectedPath(
  target: string,
  allowedOwner: number,
  pluginUid: number,
  kind: "file" | "directory",
): string {
  const absolute = path.resolve(target);
  const inputStat = fs.lstatSync(absolute);
  if (inputStat.isSymbolicLink()) {
    throw new Error("C07_PLUGIN_PROCESS_PATH_INVALID");
  }
  const resolved = fs.realpathSync.native(absolute);
  const stat = fs.statSync(resolved);
  if (
    (kind === "file" ? !stat.isFile() : !stat.isDirectory()) ||
    (stat.uid !== 0 && stat.uid !== allowedOwner) ||
    stat.uid === pluginUid ||
    stat.mode & 0o022
  ) {
    throw new Error("C07_PLUGIN_PROCESS_PATH_UNTRUSTED");
  }
  return resolved;
}

function assertProtectedAncestors(
  root: string,
  target: string,
  allowedOwner: number,
  pluginUid: number,
) {
  let current = path.dirname(target);
  while (current !== root) {
    assertProtectedPath(current, allowedOwner, pluginUid, "directory");
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(`${root}${path.sep}`)) {
      throw new Error("C07_PLUGIN_PROCESS_PATH_INVALID");
    }
    current = parent;
  }
}

function assertPluginPrivateDirectory(target: string, pluginUid: number): string {
  const absolute = path.resolve(target);
  const inputStat = fs.lstatSync(absolute);
  if (inputStat.isSymbolicLink()) {
    throw new Error("C07_PLUGIN_PROCESS_PATH_INVALID");
  }
  const resolved = fs.realpathSync.native(absolute);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory() || stat.uid !== pluginUid || stat.mode & 0o077) {
    throw new Error("C07_PLUGIN_PROCESS_SANDBOX_PATH_UNTRUSTED");
  }
  return resolved;
}

function digestFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function prepareArtifact(params: {
  packageRoot: string;
  entryPath: string;
  expectedImplementationDigest: string;
  supervisorUid: number;
  pluginUid: number;
}): { packageRoot: string; entryPath: string; workerPath: string } {
  if (!/^[a-f0-9]{64}$/u.test(params.expectedImplementationDigest)) {
    throw new Error("C07_PLUGIN_PROCESS_DIGEST_INVALID");
  }
  const packageRoot = assertProtectedPath(
    params.packageRoot,
    params.supervisorUid,
    params.pluginUid,
    "directory",
  );
  const entryPath = assertProtectedPath(
    params.entryPath,
    params.supervisorUid,
    params.pluginUid,
    "file",
  );
  const relative = path.relative(packageRoot, entryPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("C07_PLUGIN_PROCESS_PATH_INVALID");
  }
  assertProtectedAncestors(packageRoot, entryPath, params.supervisorUid, params.pluginUid);
  if (digestFile(entryPath) !== params.expectedImplementationDigest) {
    throw new Error("C07_PLUGIN_PROCESS_DIGEST_MISMATCH");
  }
  const workerPath = assertProtectedPath(
    fileURLToPath(new URL("./governor-memory-plugin-worker.js", import.meta.url)),
    params.supervisorUid,
    params.pluginUid,
    "file",
  );
  return { packageRoot, entryPath, workerPath };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function closeChild(
  child: ChildProcess,
  sendClose: () => void | Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    await sendClose();
  } catch {
    // A closed IPC channel still falls through to exact process termination.
  }
  if (await waitForExit(child, CLOSE_GRACE_MS)) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, CLOSE_GRACE_MS)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExit(child, CLOSE_GRACE_MS))) {
    throw new Error("C07_PLUGIN_PROCESS_CLOSE_FAILED");
  }
}

/** Starts an isolated, untrusted plugin worker. It exposes no C07 authority operation. */
export async function startC07PluginProcess(params: {
  packageRoot: string;
  entryPath: string;
  expectedImplementationDigest: string;
  pluginUid: number;
  pluginGid: number;
  pluginHome: string;
  pluginTemp: string;
}): Promise<C07PluginProcess> {
  const identity = assertUnixIdentity(params.pluginUid, params.pluginGid);
  const artifact = prepareArtifact({
    ...params,
    supervisorUid: identity.supervisorUid,
  });
  const pluginHome = assertPluginPrivateDirectory(params.pluginHome, params.pluginUid);
  const pluginTemp = assertPluginPrivateDirectory(params.pluginTemp, params.pluginUid);
  const bootEpoch = randomDigest();
  const child = spawn(
    process.execPath,
    [
      artifact.workerPath,
      artifact.packageRoot,
      artifact.entryPath,
      params.expectedImplementationDigest,
      bootEpoch,
      String(params.pluginUid),
      String(params.pluginGid),
    ],
    {
      cwd: artifact.packageRoot,
      env: {
        HOME: pluginHome,
        TMPDIR: pluginTemp,
        NODE_ENV: "production",
      },
      detached: false,
      windowsHide: true,
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );

  let sequence = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<string, PendingInvocation>();
  const attestation = await new Promise<C07PluginProcessAttestation>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = () => fail(new Error("C07_PLUGIN_PROCESS_EXITED_BEFORE_READY"));
    const onMessage = (raw: unknown) => {
      try {
        const frame = parseC07PluginWorkerFrame(raw);
        if (
          frame.type !== "ready" ||
          frame.bootEpoch !== bootEpoch ||
          frame.pid !== child.pid ||
          frame.uid !== params.pluginUid ||
          frame.gid !== params.pluginGid ||
          frame.groups.some((group) => group !== params.pluginGid) ||
          frame.implementationDigest !== params.expectedImplementationDigest
        ) {
          throw new Error("C07_PLUGIN_PROCESS_ATTESTATION_INVALID");
        }
        cleanup();
        resolve(
          Object.freeze({
            pid: frame.pid,
            uid: frame.uid,
            gid: frame.gid,
            groups: Object.freeze([...frame.groups]),
            bootEpoch,
            implementationDigest: frame.implementationDigest,
          }),
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error("C07_PLUGIN_PROCESS_ATTESTATION_INVALID"));
      }
    };
    const timeout = setTimeout(
      () => fail(new Error("C07_PLUGIN_PROCESS_HANDSHAKE_TIMEOUT")),
      HANDSHAKE_TIMEOUT_MS,
    );
    timeout.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.on("message", onMessage);
  }).catch(async (error: unknown) => {
    await closeChild(child, () => undefined);
    throw error;
  });

  const rejectPending = (error: Error) => {
    for (const invocation of pending.values()) {
      clearTimeout(invocation.timeout);
      invocation.reject(error);
    }
    pending.clear();
  };
  child.on("message", (raw) => {
    let frame;
    try {
      frame = parseC07PluginWorkerFrame(raw);
    } catch {
      rejectPending(new Error("C07_PLUGIN_PROCESS_PROTOCOL_INVALID"));
      return;
    }
    if (frame.type === "fatal" && frame.bootEpoch === bootEpoch) {
      rejectPending(new Error(frame.errorCode));
      return;
    }
    if (frame.type !== "result" || frame.bootEpoch !== bootEpoch) {
      return;
    }
    const invocation = pending.get(frame.requestId);
    if (!invocation || invocation.sequence !== frame.sequence) {
      rejectPending(new Error("C07_PLUGIN_PROCESS_PROTOCOL_INVALID"));
      return;
    }
    pending.delete(frame.requestId);
    clearTimeout(invocation.timeout);
    if (frame.ok && frame.payload !== undefined) {
      invocation.resolve(frame.payload);
    } else {
      invocation.reject(new Error(frame.errorCode ?? "PLUGIN_INVOCATION_FAILED"));
    }
  });
  child.once("exit", () => rejectPending(new Error("C07_PLUGIN_PROCESS_EXITED")));

  const send = async (frame: C07PluginHostFrame): Promise<void> => {
    parseC07PluginHostFrame(frame);
    if (!child.connected) {
      throw new Error("C07_PLUGIN_PROCESS_CHANNEL_CLOSED");
    }
    await new Promise<void>((resolve, reject) => {
      child.send(frame, (error) => {
        if (error) {
          reject(new Error("C07_PLUGIN_PROCESS_CHANNEL_CLOSED", { cause: error }));
        } else {
          resolve();
        }
      });
    });
  };
  const close = async () => {
    if (closePromise) {
      return await closePromise;
    }
    closed = true;
    closePromise = (async () => {
      rejectPending(new Error("C07_PLUGIN_PROCESS_CLOSED"));
      await closeChild(child, async () => {
        sequence += 1;
        await send({
          type: "close",
          version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
          bootEpoch,
          sequence,
        });
      });
    })();
    return await closePromise;
  };
  return Object.freeze({
    attestation,
    async invoke(payload: C07PluginJson) {
      if (closed) {
        throw new Error("C07_PLUGIN_PROCESS_CLOSED");
      }
      const requestId = randomDigest();
      sequence += 1;
      const result = new Promise<C07PluginJson>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("C07_PLUGIN_PROCESS_INVOCATION_TIMEOUT"));
        }, INVOCATION_TIMEOUT_MS);
        timeout.unref();
        pending.set(requestId, { sequence, timeout, resolve, reject });
      });
      void result.catch(() => undefined);
      try {
        await send({
          type: "invoke",
          version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
          bootEpoch,
          requestId,
          sequence,
          payload,
        });
      } catch (error) {
        const invocation = pending.get(requestId);
        if (invocation) {
          clearTimeout(invocation.timeout);
          pending.delete(requestId);
        }
        throw error;
      }
      return await result;
    },
    close,
  });
}
