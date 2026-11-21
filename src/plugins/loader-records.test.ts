import { afterEach, expect, it, vi } from "vitest";
import { createPluginRecord, recordPluginError } from "./loader-records.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function recordError(error: Error, origin: "global" | "bundled", missingDependencyHint?: string) {
  const id = origin === "global" ? "broken-plugin" : "discord";
  const record = createPluginRecord({
    id,
    source: `/tmp/${id}/index.js`,
    origin,
    enabled: true,
    configSchema: false,
  });
  recordPluginError({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registry: createEmptyPluginRegistry(),
    record,
    seenIds: new Map(),
    phase: "load",
    error,
    missingDependencyHint,
  });
  return record.error;
}

afterEach(() => vi.unstubAllEnvs());

function throwingAccessor(error: Error, property: "cause" | "code") {
  return Object.defineProperty(error, property, {
    get(): never {
      throw new Error(`${property} exploded`);
    },
  });
}

it.each([
  { diagnostics: "", expected: "Error: boom" },
  { diagnostics: "1", expected: "Error: boom\n    at plugin-entry.ts:1:1" },
])("uses lifecycle tracing for loader error stacks", ({ diagnostics, expected }) => {
  vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", diagnostics);
  const error = new Error("boom");
  error.stack = "Error: boom\n    at plugin-entry.ts:1:1";

  expect(recordError(error, "global")).toBe(expected);
});

it.each([
  {
    name: "names the install path when a missing module sits on the error cause",
    error: new Error("import failed", {
      cause: Object.assign(new Error("Cannot find module 'discord-api-types/v10'"), {
        code: "MODULE_NOT_FOUND",
      }),
    }),
    expected: "install @openclaw/discord (Error: import failed)",
  },
  {
    name: "keeps unrelated failures verbatim",
    error: new Error("boom"),
    expected: "Error: boom",
  },
  {
    name: "survives a nested throwing code accessor without rethrowing",
    error: new Error("wrapped", { cause: throwingAccessor(new Error("nested"), "code") }),
    expected: "Error: wrapped",
  },
  {
    name: "survives a throwing cause accessor without rethrowing",
    error: throwingAccessor(new Error("hostile"), "cause"),
    expected: "Error: hostile",
  },
])("$name", ({ error, expected }) => {
  expect(recordError(error, "bundled", "install @openclaw/discord")).toBe(expected);
});

it.each([
  { kind: "null-prototype", trace: "", expected: "{}" },
  { kind: "message-getter", trace: "", expected: "Error" },
  { kind: "stack-getter", trace: "1", expected: "stack fallback" },
])("L07-F09 records an unreadable $kind failure", ({ kind, trace, expected }) => {
  vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", trace);
  const error: unknown =
    kind === "null-prototype" ? Object.create(null) : new Error("stack fallback");
  if (kind !== "null-prototype") {
    Object.defineProperty(error, kind === "message-getter" ? "message" : "stack", {
      get() {
        throw new Error("synthetic display accessor failed");
      },
    });
  }
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "unreadable-plugin",
    source: "/tmp/unreadable-plugin/index.js",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  const seenIds = new Map();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let recordingError: unknown;

  try {
    recordPluginError({
      logger,
      registry,
      record,
      seenIds,
      phase: "register",
      error,
    });
  } catch (failure) {
    recordingError = failure;
  }

  expect({
    threw: recordingError !== undefined,
    plugins: registry.plugins.map(({ id, status, error: text, failurePhase }) => ({
      id,
      status,
      error: text,
      failurePhase,
    })),
    diagnostics: registry.diagnostics.map(({ level, pluginId, message }) => ({
      level,
      pluginId,
      message,
    })),
    seenIds: [...seenIds],
    logged: logger.error.mock.calls,
  }).toEqual({
    threw: false,
    plugins: [{ id: record.id, status: "error", error: expected, failurePhase: "register" }],
    diagnostics: [{ level: "error", pluginId: record.id, message: expected }],
    seenIds: [[record.id, "workspace"]],
    logged: [[expected]],
  });
});
