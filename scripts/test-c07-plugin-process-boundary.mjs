#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function requiredIdentity(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} must name a non-root test identity`);
  }
  return value;
}

function writePrivateDirectory(target, uid, gid) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chownSync(target, uid, gid);
  fs.chmodSync(target, 0o700);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

if ((process.platform !== "linux" && process.platform !== "darwin") || process.getuid?.() !== 0) {
  fail("C07 OS-boundary integration requires a root-owned Linux or macOS test host");
}

const pluginUid = requiredIdentity("C07_TEST_PLUGIN_UID");
const pluginGid = requiredIdentity("C07_TEST_PLUGIN_GID");
const repoRoot = path.resolve(import.meta.dirname, "..");
const runtimeModule = path.join(repoRoot, "dist/security/governor-memory-plugin-process.js");
if (!fs.statSync(runtimeModule).isFile()) {
  fail("built C07 process runtime is missing");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c07-process-"));
const packageRoot = path.join(root, "plugin");
const pluginHome = path.join(root, "home");
const pluginTemp = path.join(root, "tmp");
const authorityRoot = path.join(root, "authority");
const authorityFile = path.join(authorityRoot, "secret");
const entryPath = path.join(packageRoot, "entry.mjs");
const pluginSource = `
import fs from "node:fs";
export async function handleC07PluginInvocation(payload) {
  if (payload.operation === "echo") return { value: payload.value };
  if (payload.operation === "probe") {
    try { fs.readFileSync(payload.path); return { denied: false }; }
    catch (error) { return { denied: true, code: error?.code ?? "UNKNOWN" }; }
  }
  throw new Error("unsupported fixture operation");
}
`;

let worker;
try {
  fs.mkdirSync(packageRoot, { mode: 0o755 });
  fs.writeFileSync(entryPath, pluginSource, { mode: 0o644 });
  fs.mkdirSync(authorityRoot, { mode: 0o700 });
  fs.writeFileSync(authorityFile, "not-an-evidence-value", { mode: 0o600 });
  fs.chownSync(root, 0, 0);
  fs.chownSync(packageRoot, 0, 0);
  fs.chownSync(entryPath, 0, 0);
  fs.chownSync(authorityRoot, 0, 0);
  fs.chownSync(authorityFile, 0, 0);
  fs.chmodSync(root, 0o755);
  writePrivateDirectory(pluginHome, pluginUid, pluginGid);
  writePrivateDirectory(pluginTemp, pluginUid, pluginGid);

  const { startC07PluginProcess } = await import(pathToFileURL(runtimeModule).href);
  await startC07PluginProcess({
    packageRoot,
    entryPath,
    expectedImplementationDigest: sha256(entryPath),
    pluginUid: 0,
    pluginGid,
    pluginHome,
    pluginTemp,
  }).then(
    () => fail("root plugin identity was accepted"),
    (error) => {
      if (!String(error).includes("C07_PLUGIN_PROCESS_PLATFORM_UNSUPPORTED")) {
        throw error;
      }
    },
  );
  worker = await startC07PluginProcess({
    packageRoot,
    entryPath,
    expectedImplementationDigest: sha256(entryPath),
    pluginUid,
    pluginGid,
    pluginHome,
    pluginTemp,
  });
  assertEqual(worker.attestation.uid, pluginUid, "worker uid");
  assertEqual(worker.attestation.gid, pluginGid, "worker gid");
  assertEqual(worker.attestation.groups, [pluginGid], "worker groups");
  assertEqual(
    await worker.invoke({ operation: "echo", value: "bounded" }),
    {
      value: "bounded",
    },
    "bounded invocation",
  );
  assertEqual(
    await worker.invoke({ operation: "probe", path: authorityFile }),
    {
      denied: true,
      code: "EACCES",
    },
    "authority path isolation",
  );
  const pid = worker.attestation.pid;
  await worker.close();
  await worker.close();
  try {
    process.kill(pid, 0);
    fail("plugin process survived close");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  console.log(JSON.stringify({ status: "pass", invocations: 2, processesRemaining: 0 }));
} finally {
  await worker?.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}
