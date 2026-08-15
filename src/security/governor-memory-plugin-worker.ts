import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
  type C07PluginJson,
  type C07PluginWorkerFrame,
  parseC07PluginHostFrame,
  parseC07PluginWorkerFrame,
} from "./governor-memory-plugin-process-protocol.js";

type PluginModule = Readonly<{
  handleC07PluginInvocation?: (payload: C07PluginJson) => C07PluginJson | Promise<C07PluginJson>;
}>;

function digestFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function send(frame: C07PluginWorkerFrame): void {
  parseC07PluginWorkerFrame(frame);
  if (!process.connected || !process.send) {
    throw new Error("C07_PLUGIN_PROCESS_CHANNEL_CLOSED");
  }
  process.send(frame);
}

function fatal(
  bootEpoch: string,
  errorCode: "PLUGIN_BOOT_INVALID" | "PLUGIN_PROTOCOL_INVALID",
): never {
  try {
    send({
      type: "fatal",
      version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
      bootEpoch,
      errorCode,
    });
  } finally {
    process.exit(1);
  }
}

const [
  packageRootInput,
  entryPathInput,
  expectedDigest,
  bootEpoch,
  pluginUidInput,
  pluginGidInput,
] = process.argv.slice(2);
let packageRoot: string;
let entryPath: string;
let pluginUid: number;
let pluginGid: number;
try {
  pluginUid = Number(pluginUidInput);
  pluginGid = Number(pluginGidInput);
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    typeof process.getgroups !== "function" ||
    typeof process.setgroups !== "function" ||
    typeof process.setgid !== "function" ||
    typeof process.setuid !== "function" ||
    process.getuid() !== 0 ||
    !Number.isSafeInteger(pluginUid) ||
    pluginUid <= 0 ||
    !Number.isSafeInteger(pluginGid) ||
    pluginGid <= 0 ||
    !packageRootInput ||
    !entryPathInput ||
    !/^[a-f0-9]{64}$/u.test(expectedDigest ?? "") ||
    !/^[a-f0-9]{64}$/u.test(bootEpoch ?? "")
  ) {
    throw new Error("invalid worker bootstrap");
  }
  packageRoot = fs.realpathSync.native(path.resolve(packageRootInput));
  entryPath = fs.realpathSync.native(path.resolve(entryPathInput));
  const relative = path.relative(packageRoot, entryPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("worker entry escapes package root");
  }
  if (digestFile(entryPath) !== expectedDigest) {
    throw new Error("worker implementation digest mismatch");
  }
  process.setgroups([pluginGid]);
  process.setgid(pluginGid);
  process.setuid(pluginUid);
  if (
    process.getuid() !== pluginUid ||
    process.getgid() !== pluginGid ||
    process.getgroups().some((group) => group !== pluginGid)
  ) {
    throw new Error("worker identity drop mismatch");
  }
} catch {
  fatal(bootEpoch ?? "0".repeat(64), "PLUGIN_BOOT_INVALID");
}

const workerBootEpoch = bootEpoch!;
let expectedSequence = 1;
let modulePromise: Promise<PluginModule> | undefined;

send({
  type: "ready",
  version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
  bootEpoch: workerBootEpoch,
  pid: process.pid,
  uid: process.getuid!(),
  gid: process.getgid!(),
  groups: process.getgroups!(),
  implementationDigest: expectedDigest!,
});

process.on("message", (raw) => {
  void (async () => {
    let frame;
    try {
      frame = parseC07PluginHostFrame(raw);
      if (frame.bootEpoch !== workerBootEpoch || frame.sequence !== expectedSequence) {
        throw new Error("worker sequence mismatch");
      }
      expectedSequence += 1;
    } catch {
      fatal(workerBootEpoch, "PLUGIN_PROTOCOL_INVALID");
      return;
    }
    if (frame.type === "close") {
      process.disconnect?.();
      return;
    }
    try {
      modulePromise ??= import(pathToFileURL(entryPath).href) as Promise<PluginModule>;
      const plugin = await modulePromise;
      if (typeof plugin.handleC07PluginInvocation !== "function") {
        throw new Error("plugin invocation export missing");
      }
      const payload = await plugin.handleC07PluginInvocation(frame.payload);
      send({
        type: "result",
        version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
        bootEpoch: workerBootEpoch,
        requestId: frame.requestId,
        sequence: frame.sequence,
        ok: true,
        payload,
      });
    } catch {
      send({
        type: "result",
        version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
        bootEpoch: workerBootEpoch,
        requestId: frame.requestId,
        sequence: frame.sequence,
        ok: false,
        errorCode: "PLUGIN_INVOCATION_FAILED",
      });
    }
  })();
});
