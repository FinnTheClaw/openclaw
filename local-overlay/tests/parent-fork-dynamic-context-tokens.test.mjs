import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const target = process.argv[2] || "/opt/homebrew/lib/node_modules/openclaw";
const packageJson = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
assert.equal(packageJson.version, "2026.7.1-2");

const sessionForkPath = path.join(target, "dist/session-fork-B_4CoW5e.js");
const sessionForkSource = fs.readFileSync(sessionForkPath, "utf8");
const openclawToolsSource = fs.readFileSync(
  path.join(target, "dist/openclaw-tools-KulZ1cdH.js"),
  "utf8",
);
const getReplySource = fs.readFileSync(path.join(target, "dist/get-reply-OTG64ybi.js"), "utf8");
const sessionCreateSource = fs.readFileSync(
  path.join(target, "dist/session-create-service-14oZxrT5.js"),
  "utf8",
);
const realtimeVoiceSource = fs.readFileSync(
  path.join(target, "dist/realtime-voice-DS5n5Pmp.js"),
  "utf8",
);
assert.match(
  sessionForkSource,
  /import \{ o as resolveContextTokensForModel \} from "\.\/context-_zWLdTOu\.js";/,
  "the session-fork bundle must use the package's canonical context resolver",
);
assert.match(sessionForkSource, /function resolveParentForkMaxTokens\(params\)/);
assert.match(
  sessionForkSource,
  /resolveDecision: \(parentEntry\) => resolveParentForkDecision\(\{[\s\S]*?config: params\.config,[\s\S]*?storePath/,
  "the shared storage-boundary decision must receive runtime config",
);
assert.match(
  openclawToolsSource,
  /forkSessionEntryFromParent\(\{[\s\S]*?agentId: params\.requesterAgentId,\s*config: params\.cfg\s*\}\)/,
  "subagent context forks must receive runtime config",
);
assert.match(
  getReplySource,
  /resolveParentForkDecision\(\{\s*parentEntry,\s*agentId: params\.agentId,\s*config: params\.config,\s*storePath: params\.storePath\s*\}\)/,
  "threaded-reply fork decisions must receive runtime config",
);
assert.match(
  getReplySource,
  /prepareReplySessionParentFork\(\{\s*agentId,\s*alreadyForked,\s*config: cfg,\s*parentSessionKey/,
  "threaded-reply setup must propagate runtime config into its decision helper",
);
assert.match(
  sessionCreateSource,
  /resolveParentForkDecision\(\{\s*parentEntry: currentParentSessionEntry,\s*agentId: parentSessionTarget\.agentId,\s*config: params\.cfg,\s*storePath: parentSessionTarget\.storePath\s*\}\)/,
  "operator-created session forks must receive runtime config",
);
assert.match(
  realtimeVoiceSource,
  /forkSessionEntryFromParent\(\{[\s\S]*?agentId: params\.agentId,\s*config: params\.cfg,\s*sessionKey: params\.sessionKey/,
  "realtime voice forks must retain their existing runtime config propagation",
);

let observedModelResolution;
let resolveParentForkDecision;
try {
  const moduleUrl = pathToFileURL(sessionForkPath);
  moduleUrl.searchParams.set("parent-fork-regression", String(Date.now()));
  const sessionForkModule = await import(moduleUrl.href);
  resolveParentForkDecision = Object.values(sessionForkModule).find(
    (value) => typeof value === "function" && value.name === "resolveParentForkDecision",
  );
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  const executableSource = sessionForkSource
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/^export \{.*\};\r?\n?/gm, "")
    .concat("\nglobalThis.__resolveParentForkDecision = resolveParentForkDecision;\n");
  const sandbox = {
    createLazyImportLoader: () => ({
      load: async () => ({
        resolveParentForkTokenCountRuntime: async ({ parentEntry }) => parentEntry.totalTokens,
      }),
    }),
    resolveContextTokensForModel: (params) => {
      observedModelResolution = params;
      const provider = params.cfg?.models?.providers?.[params.provider];
      const model = provider?.models?.find((entry) => entry.id === params.model);
      return model?.contextTokens ?? model?.contextWindow ?? params.fallbackContextTokens;
    },
    resolveStorePath: () => "/parent-fork-regression-store",
    forkSessionFromParentTranscript: async () => ({ status: "created", transcript: [] }),
    forkSessionEntryFromParentTarget: async () => ({ status: "created" }),
  };
  vm.runInNewContext(executableSource, sandbox, { filename: sessionForkPath });
  resolveParentForkDecision = sandbox.__resolveParentForkDecision;
}
assert.equal(
  typeof resolveParentForkDecision,
  "function",
  "the compiled session-fork bundle must define resolveParentForkDecision",
);

const parentTokens = 166_533;
const parentEntry = {
  sessionId: "parent-fork-regression",
  totalTokens: parentTokens,
  totalTokensFresh: true,
};
const missingStorePath = path.join(target, ".parent-fork-regression-store-does-not-exist");

const entryBudgetDecision = await resolveParentForkDecision({
  parentEntry: { ...parentEntry, contextTokens: 250_000 },
  storePath: missingStorePath,
});
assert.equal(entryBudgetDecision.status, "fork");
assert.equal(entryBudgetDecision.maxTokens, 250_000);
assert.equal(entryBudgetDecision.parentTokens, parentTokens);

const configuredDefaultDecision = await resolveParentForkDecision({
  parentEntry,
  config: { agents: { defaults: { contextTokens: 250_000 } } },
  storePath: missingStorePath,
});
assert.equal(configuredDefaultDecision.status, "fork");
assert.equal(configuredDefaultDecision.maxTokens, 250_000);
assert.equal(configuredDefaultDecision.parentTokens, parentTokens);

const configuredModelDecision = await resolveParentForkDecision({
  parentEntry: {
    ...parentEntry,
    modelProvider: "remote-llm",
    model: "moira/brain",
  },
  config: {
    agents: { defaults: { contextTokens: 120_000 } },
    models: {
      providers: {
        "remote-llm": {
          models: [{ id: "moira/brain", contextWindow: 250_000 }],
        },
      },
    },
  },
  storePath: missingStorePath,
});
assert.equal(configuredModelDecision.status, "fork");
assert.equal(configuredModelDecision.maxTokens, 250_000);
assert.equal(configuredModelDecision.parentTokens, parentTokens);
if (observedModelResolution) {
  assert.equal(observedModelResolution.provider, "remote-llm");
  assert.equal(observedModelResolution.model, "moira/brain");
  assert.equal(observedModelResolution.fallbackContextTokens, 120_000);
  assert.equal(observedModelResolution.allowAsyncLoad, false);
}

const overflowDecision = await resolveParentForkDecision({
  parentEntry: {
    ...parentEntry,
    contextTokens: 250_000,
    totalTokens: 250_001,
  },
  storePath: missingStorePath,
});
assert.equal(overflowDecision.status, "skip");
assert.equal(overflowDecision.reason, "parent-too-large");
assert.equal(overflowDecision.maxTokens, 250_000);
assert.equal(overflowDecision.parentTokens, 250_001);

const legacyFallbackDecision = await resolveParentForkDecision({
  parentEntry,
  storePath: missingStorePath,
});
assert.equal(legacyFallbackDecision.status, "skip");
assert.equal(legacyFallbackDecision.reason, "parent-too-large");
assert.equal(legacyFallbackDecision.maxTokens, 100_000);
assert.equal(legacyFallbackDecision.parentTokens, parentTokens);
assert.match(legacyFallbackDecision.message, /166533\/100000 tokens/);

console.log("parent-fork dynamic context tokens regression: PASS");
