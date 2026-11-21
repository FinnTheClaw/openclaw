import { randomUUID } from "node:crypto";
import fs from "node:fs";
import JSON5 from "json5";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL, restoreRedactedValues } from "../config/redact-snapshot.js";
import { makeSnapshot } from "../config/redact-snapshot.test-helpers.js";
import {
  invalidateGatewayRuntimeConfigSchema,
  loadGatewayConfigRedactionHints,
} from "../config/runtime-schema.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import * as schema from "../config/schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  pluginRegistryVersion: 1,
  config: {} as OpenClawConfig,
  snapshot: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.snapshot,
  getRuntimeConfig: () => mocks.config,
}));

vi.mock("../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "applied-1",
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistryVersion: () => mocks.pluginRegistryVersion,
}));

const { invalidateConfigGetResponseCache, readConfigGetResponse: readResponseImpl } =
  await import("./config-get-response.js");

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
  hashResponseSessionBearer: () => "unused-test-scope",
};

function readResponse(params: Omit<Parameters<typeof readResponseImpl>[0], "revisionProjector">) {
  return readResponseImpl({ ...params, revisionProjector });
}

const withToken = (kind: string) => ({
  gateway: { auth: { token: `synthetic-${kind}-token-canary` } },
});
const activeWatcher = () => "active" as const;
const disabledWatcher = () => "disabled" as const;
const readWatched = () => readResponse({ getHotReloadStatus: activeWatcher });

function webhookRoutes(routes: Record<string, unknown>, enabled?: boolean): OpenClawConfig {
  const webhooks = { config: { routes }, ...(enabled === undefined ? {} : { enabled }) };
  return { plugins: { entries: { webhooks } } };
}

function objectSchema(properties: Record<string, unknown>, $defs?: Record<string, unknown>) {
  return { type: "object", properties, ...($defs ? { $defs } : {}) };
}

beforeEach(() => {
  invalidateConfigGetResponseCache();
  mocks.pluginRegistryVersion = 1;
  mocks.config = {};
  invalidateGatewayRuntimeConfigSchema();
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture({ plugins: [] }));
  mocks.snapshot.mockReset().mockResolvedValue(makeSnapshot({ gateway: { port: 19_001 } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCurrentPluginMetadataSnapshot();
  invalidateGatewayRuntimeConfigSchema();
});

it("redacts cold config reads without building the form schema", async () => {
  mocks.config = withToken("cold");
  mocks.config.env = { vars: { REDACTION_TEST_INLINE: "synthetic-inline-credential" } };
  mocks.snapshot.mockResolvedValue(makeSnapshot(mocks.config));
  const buildSchema = vi.spyOn(schema, "buildConfigSchemaCore");

  const response = await readWatched();
  expect(response.config.gateway?.auth?.token).toBe(REDACTED_SENTINEL);
  expect(response.config.env?.vars?.REDACTION_TEST_INLINE).toBe(REDACTED_SENTINEL);
  expect(JSON.stringify(response)).not.toContain("synthetic-inline-credential");
  expect(JSON.stringify(response)).not.toContain("synthetic-cold-token-canary");
  expect(buildSchema).not.toHaveBeenCalled();
});

it("round-trips wildcard plugin SecretRefs through an unrelated form save", async () => {
  const secretRef = {
    source: "store" as const,
    provider: "default",
    id: `TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`,
  };
  const plaintext = randomUUID();
  const config = webhookRoutes(
    {
      publish: { sessionKey: "agent:main", secret: secretRef },
      deploy: { sessionKey: "agent:main", secret: secretRef },
      plain: { sessionKey: "agent:main", secret: plaintext },
    },
    true,
  );
  config.gateway = { port: 19_001 };
  const { manifestRegistry } = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "webhooks",
        origin: "bundled",
        configContracts: {
          secretInputs: {
            paths: [{ path: "routes.*.secret", expected: "string", ownerKind: "route" }],
          },
        },
        configSchema: objectSchema(
          {
            routes: { type: "object", additionalProperties: { $ref: "#/$defs/route" } },
          },
          {
            secretRef: objectSchema({
              source: { type: "string" },
              provider: { type: "string" },
              id: { type: "string" },
            }),
            secretInput: {
              anyOf: [{ type: "string" }, { $ref: "#/$defs/secretRef" }],
            },
            route: objectSchema({ secret: { $ref: "#/$defs/secretInput" } }),
          },
        ),
      },
    ],
  });
  mocks.config = config;
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(manifestRegistry));
  const uiHints = loadGatewayConfigRedactionHints();
  const secretPath = "plugins.entries.webhooks.config.routes.*.secret";
  expect(uiHints[secretPath]?.sensitive).toBe(true);

  mocks.snapshot.mockResolvedValue(makeSnapshot(config));
  const response = await readResponse({});
  const redactedSecret = { ...secretRef, id: REDACTED_SENTINEL };
  expect(response.config.plugins?.entries?.webhooks?.config).toMatchObject({
    routes: {
      publish: { secret: redactedSecret },
      deploy: { secret: redactedSecret },
      plain: { secret: REDACTED_SENTINEL },
    },
  });
  expect(response.raw).toContain(REDACTED_SENTINEL);
  expect(JSON.stringify(response)).not.toContain(plaintext);
  expect(JSON.stringify(response)).not.toContain(secretRef.id);

  const formValue = structuredClone(response.config);
  formValue.gateway = { ...formValue.gateway, port: 19_002 };
  expect(restoreRedactedValues(formValue, config, uiHints)).toEqual({
    ok: true,
    result: { ...config, gateway: { port: 19_002 } },
  });
});

it("redacts every projection, including disabled channel owners", async () => {
  const config: OpenClawConfig = {
    plugins: {
      entries: { core: { enabled: true }, plus: { enabled: false } },
    },
    channels: {
      proofchat: {
        core: "synthetic-core",
        plus: "synthetic-plus",
        visibleToken: "public-setting",
        endpoint: "https://synthetic-user:synthetic-password@example.test",
      },
    },
  };
  const { manifestRegistry } = createPluginMetadataSnapshotFixture({
    plugins: ["core", "plus"].map((id) => ({
      id,
      origin: "config",
      channels: ["proofchat"],
      channelConfigs: {
        proofchat: {
          schema: objectSchema({ [id]: { type: "string" } }),
          uiHints: {
            [id]: { sensitive: true },
            visibleToken: { sensitive: false },
            endpoint: { sensitive: false, tags: ["url-secret"] },
          },
        },
      },
    })),
  });
  mocks.snapshot.mockResolvedValue(makeSnapshot(config));
  mocks.config = config;
  setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(manifestRegistry));
  const response = await readResponse({});
  const output = JSON.stringify(response);
  expect(output).not.toContain("synthetic-core");
  expect(output).not.toContain("synthetic-plus");
  expect(output).not.toContain("synthetic-password");
  const redacted = REDACTED_SENTINEL;
  const proofchat = {
    core: redacted,
    plus: redacted,
    visibleToken: "public-setting",
    endpoint: redacted,
  };
  const projected = { channels: { proofchat } };
  expect(response).toMatchObject({
    config: projected,
    sourceConfig: projected,
    runtimeConfig: projected,
    parsed: projected,
    resolved: projected,
  });
  expect(response.raw).toContain("public-setting");
});

it("serves identical bytes without filesystem work on an active-watcher cache hit", async () => {
  const first = await readWatched();
  const stat = vi.spyOn(fs.promises, "stat");
  mocks.snapshot.mockClear();

  const hit = await readWatched();

  expect(hit).toBe(first);
  expect(stat).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();

  invalidateConfigGetResponseCache();
  const fresh = await readWatched();
  expect(hit).toEqual(fresh);
  await expect(readResponse({ getHotReloadStatus: disabledWatcher })).resolves.toEqual(fresh);
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it("shares one projection across concurrent active-watcher callers", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => readWatched()));

  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(responses.every((response) => response === responses[0])).toBe(true);
});

it.each(["read failure", "metadata generation"])("rebuilds after %s", async (reason) => {
  if (reason === "read failure") {
    mocks.snapshot.mockRejectedValueOnce(new Error("transient read failure"));
    await expect(readWatched()).rejects.toThrow("transient read failure");
  } else {
    await readWatched();
    mocks.pluginRegistryVersion = 2;
  }
  await expect(readWatched()).resolves.toMatchObject({
    appliedConfigHash: "resolved-token:applied-1",
  });
  expect(mocks.snapshot).toHaveBeenCalledTimes(2);
});

it.each([
  {
    name: "Unicode escape",
    raw: String.raw`{"gateway":{"mode":"local","auth":{"mode":"password","password":"synth\u0065tic"}}}`,
    credential: "synthetic",
    redactRaw: true,
  },
  {
    name: "escaped quote",
    raw: String.raw`{"gateway":{"mode":"local","auth":{"mode":"password","password":"synthetic\"quote"}}}`,
    credential: 'synthetic"quote',
    redactRaw: true,
  },
  {
    name: "escaped backslash",
    raw: String.raw`{"gateway":{"mode":"local","auth":{"mode":"password","password":"synthetic\\path"}}}`,
    credential: String.raw`synthetic\path`,
    redactRaw: true,
  },
  {
    name: "escaped newline",
    raw: String.raw`{"gateway":{"mode":"local","auth":{"mode":"password","password":"synthetic\nline"}}}`,
    credential: "synthetic\nline",
    redactRaw: true,
  },
  {
    name: "literal password retains safe JSON5 formatting",
    raw: '{ /* synthetic comment */ gateway: { mode: "local", auth: { mode: "password", password: "synthetic-literal" } } }',
    credential: "synthetic-literal",
    redactRaw: false,
    expectedRaw:
      '{ /* synthetic comment */ gateway: { mode: "local", auth: { mode: "password", password: "' +
      REDACTED_SENTINEL +
      '" } } }',
  },
  {
    name: "nonsecret config retains raw text",
    raw: '{ /* no credential */ gateway: { mode: "local", port: 19001 } }',
    credential: undefined,
    redactRaw: false,
    expectedRaw: '{ /* no credential */ gateway: { mode: "local", port: 19001 } }',
  },
])("escaped inline raw credential: $name", async (scenario) => {
  const config = JSON5.parse(scenario.raw) as {
    gateway: { mode: "local"; auth?: { mode: "password"; password: string }; port?: number };
  };
  expect(config.gateway.auth?.password).toBe(scenario.credential);
  const snapshot = makeSnapshot(config, scenario.raw);
  const before = structuredClone(snapshot);
  mocks.snapshot.mockResolvedValue(snapshot);
  mocks.config = config;

  const response = await readResponse({ loadUiHints: () => undefined });
  const expected = scenario.credential
    ? {
        gateway: {
          mode: "local",
          auth: { mode: "password", password: REDACTED_SENTINEL },
        },
      }
    : { gateway: { mode: "local", port: 19001 } };
  for (const projection of [
    response.config,
    response.parsed,
    response.resolved,
    response.sourceConfig,
    response.runtimeConfig,
  ]) {
    expect(projection).toEqual(expected);
  }
  expect(response.raw).toBe(scenario.redactRaw ? null : scenario.expectedRaw);
  expect(response.hash).toBe("raw-token:abc123");
  expect(response.configRevisionHash).toBe(
    revisionProjector.projectResolvedHash(hashRuntimeConfigValue(snapshot.sourceConfig)),
  );
  expect(response.appliedConfigHash).toBe("resolved-token:applied-1");
  expect(response.valid).toBe(true);
  expect(response.issues).toEqual([]);
  expect(response.warnings).toEqual([]);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(snapshot).toEqual(before);
});
