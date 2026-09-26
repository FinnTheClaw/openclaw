import { describe, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const cases = [
  {
    id: "CP100-CB01",
    mode: "sync-success",
    tracked: true,
    success: 1,
    errors: 0,
    warnings: 0,
    initiallyPending: 0,
  },
  {
    id: "CP100-CB02",
    mode: "async-success",
    tracked: true,
    success: 1,
    errors: 0,
    warnings: 0,
    initiallyPending: 1,
  },
  {
    id: "CP100-CB03",
    mode: "sync-callback-throw",
    tracked: true,
    success: 0,
    errors: 1,
    warnings: 1,
    initiallyPending: 0,
  },
  {
    id: "CP100-CB04",
    mode: "async-rejection",
    tracked: true,
    success: 0,
    errors: 1,
    warnings: 1,
    initiallyPending: 1,
  },
  {
    id: "CP100-CB05",
    mode: "sync-on-success-throw",
    tracked: true,
    success: 1,
    errors: 1,
    warnings: 1,
    initiallyPending: 0,
  },
  {
    id: "CP100-CB06",
    mode: "async-on-success-throw",
    tracked: true,
    success: 1,
    errors: 1,
    warnings: 1,
    initiallyPending: 1,
  },
  {
    id: "CP100-CB07",
    mode: "async-on-success-reject-untracked",
    tracked: false,
    success: 1,
    errors: 1,
    warnings: 1,
    initiallyPending: 0,
  },
  {
    id: "CP100-CB08",
    mode: "on-error-throw",
    tracked: true,
    success: 0,
    errors: 1,
    warnings: 1,
    initiallyPending: 0,
  },
  {
    id: "CP100-CB09",
    mode: "warn-throw",
    tracked: true,
    success: 0,
    errors: 1,
    warnings: 1,
    initiallyPending: 1,
  },
  {
    id: "CP100-CB10",
    mode: "thenable-on-success-throw",
    tracked: true,
    success: 1,
    errors: 1,
    warnings: 1,
    initiallyPending: 1,
  },
] as const;

const childSource = `
import { installUnhandledRejectionHandler } from "./src/infra/unhandled-rejections.ts";
import { runBestEffortCallback } from "./src/agents/embedded-agent-subscribe.callback.ts";

installUnhandledRejectionHandler();
const mode = __MODE__;
const tracked = __TRACKED__;
const original = new Error("primary-" + mode);
const pending = new Set();
let callbackCalls = 0;
let successCalls = 0;
let errorCalls = 0;
let warningCalls = 0;
let errorWasOriginal = false;
let warningWasOriginal = false;

const callback = () => {
  callbackCalls += 1;
  if (mode === "sync-callback-throw" || mode === "on-error-throw") {
    throw original;
  }
  if (mode === "async-rejection" || mode === "warn-throw") {
    return Promise.reject(original);
  }
  if (mode === "thenable-on-success-throw") {
    return { then(resolve) { resolve("fulfilled"); } };
  }
  if (mode.startsWith("async-")) {
    return Promise.resolve("fulfilled");
  }
  return undefined;
};
const onSuccess = () => {
  successCalls += 1;
  if (mode === "sync-on-success-throw" || mode === "async-on-success-throw" ||
      mode === "thenable-on-success-throw") {
    throw original;
  }
  if (mode === "async-on-success-reject-untracked") {
    return Promise.reject(original);
  }
};
const onError = (error) => {
  errorCalls += 1;
  errorWasOriginal = error === original;
  if (mode === "on-error-throw") {
    throw new Error("secondary-on-error");
  }
};
const log = {
  warn(message) {
    warningCalls += 1;
    warningWasOriginal = String(message).includes(original.message);
    if (mode === "warn-throw") {
      throw new Error("secondary-warn");
    }
  },
};

try {
  runBestEffortCallback({
    callback,
    label: "callback acceptance",
    log,
    ...(tracked ? { pending } : {}),
    onSuccess,
    onError,
  });
} catch (error) {
  console.error("callback escaped: " + String(error));
  process.exit(7);
}
const initiallyPending = pending.size;
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
console.log("CP100_RESULT:" + JSON.stringify({
  callbackCalls,
  successCalls,
  errorCalls,
  warningCalls,
  errorWasOriginal,
  warningWasOriginal,
  initiallyPending,
  finallyPending: pending.size,
}));
`;

describe("best-effort callback completion containment", () => {
  it.each(cases)("$id $mode", (testCase) => {
    const source = childSource
      .replace("__MODE__", JSON.stringify(testCase.mode))
      .replace("__TRACKED__", String(testCase.tracked));
    const result = spawnNodeEvalSync(source, { imports: ["tsx"], timeout: 20_000 });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(
      /Unhandled promise rejection|FATAL unhandled rejection|Uncaught exception/,
    );
    const marker = result.stdout.split("\n").find((line) => line.startsWith("CP100_RESULT:"));
    if (!marker) {
      throw new Error("Missing child receipt for " + testCase.id + ": " + result.stdout);
    }
    expect(JSON.parse(marker.slice("CP100_RESULT:".length))).toEqual({
      callbackCalls: 1,
      successCalls: testCase.success,
      errorCalls: testCase.errors,
      warningCalls: testCase.warnings,
      errorWasOriginal: testCase.errors === 1,
      warningWasOriginal: testCase.warnings === 1,
      initiallyPending: testCase.initiallyPending,
      finallyPending: 0,
    });
  });
});
