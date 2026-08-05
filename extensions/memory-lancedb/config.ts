// Memory Lancedb helper module supports config behavior.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

export type MemoryConfig = {
  embedding: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dreaming?: Record<string, unknown>;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
  customTriggers?: string[];
  recallMaxChars?: number;
  storageOptions?: Record<string, string>;
  durableMemory: {
    enabled: boolean;
    ledgerPath: string;
    startupReconcile: boolean;
    projectionBatch: number;
    projectionConcurrency: number;
    embeddingTimeoutMs: number;
    recallTimeoutMs: number;
    recallLimit: number;
    recallBudgetChars: number;
    consolidation: {
      enabled: boolean;
      baseUrl?: string;
      apiKey?: string;
      model: string;
      timeoutMs: number;
      maxInputChars: number;
      extractionBatch: number;
      extractionConcurrency: number;
      summaryBatch: number;
      summaryConcurrency: number;
    };
  };
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
export const DEFAULT_RECALL_MAX_CHARS = 1000;
export const DEFAULT_DURABLE_LEDGER_PATH = join(homedir(), ".openclaw", "memory", "ledger.sqlite3");
export const DEFAULT_DURABLE_RECALL_TIMEOUT_MS = 3_000;
export const DEFAULT_DURABLE_RECALL_LIMIT = 6;
export const DEFAULT_DURABLE_RECALL_BUDGET_CHARS = 5_000;
const LEGACY_STATE_DIRS: string[] = [];

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "lancedb");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // best-effort
  }

  for (const legacy of LEGACY_STATE_DIRS) {
    const candidate = join(home, legacy, "memory", "lancedb");
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // best-effort
    }
  }

  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};
const EMBEDDING_CONFIG_KEYS = ["provider", "apiKey", "model", "baseUrl", "dimensions"] as const;

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEmbeddingModel(
  embedding: Record<string, unknown>,
  dimensions: number | undefined,
): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  if (dimensions === undefined) {
    vectorDimsForModel(model);
  }
  return model;
}

function resolveFiniteIntegerConfig(value: unknown): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  const parsed = parseFiniteNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function resolveBoundedIntegerConfig(params: {
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  label: string;
}): number {
  const resolved = resolveFiniteIntegerConfig(params.value) ?? params.fallback;
  if (resolved < params.min || resolved > params.max) {
    throw new Error(`${params.label} must be between ${params.min} and ${params.max}`);
  }
  return resolved;
}

function resolveEmbeddingDimensions(embedding: Record<string, unknown>): number | undefined {
  if (embedding.dimensions === undefined) {
    return undefined;
  }
  const dimensions =
    typeof embedding.dimensions === "number" ? parseFiniteNumber(embedding.dimensions) : undefined;
  if (dimensions === undefined || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("embedding.dimensions must be a positive integer");
  }
  return dimensions;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "embedding",
        "dreaming",
        "dbPath",
        "autoCapture",
        "autoRecall",
        "captureMaxChars",
        "customTriggers",
        "recallMaxChars",
        "storageOptions",
        "durableMemory",
      ],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding !== "object" || Array.isArray(embedding)) {
      throw new Error("embedding config required");
    }
    assertAllowedKeys(embedding, [...EMBEDDING_CONFIG_KEYS], "embedding config");
    if (Object.keys(embedding).length === 0) {
      throw new Error("embedding config must include at least one setting");
    }

    const dimensions = resolveEmbeddingDimensions(embedding);
    const model = resolveEmbeddingModel(embedding, dimensions);
    const provider = typeof embedding.provider === "string" ? embedding.provider.trim() : "openai";
    if (!provider) {
      throw new Error("embedding.provider must not be empty");
    }

    const captureMaxChars = resolveBoundedIntegerConfig({
      value: cfg.captureMaxChars,
      fallback: DEFAULT_CAPTURE_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "captureMaxChars",
    });
    const recallMaxChars = resolveBoundedIntegerConfig({
      value: cfg.recallMaxChars,
      fallback: DEFAULT_RECALL_MAX_CHARS,
      min: 100,
      max: 10_000,
      label: "recallMaxChars",
    });
    let customTriggers: string[] | undefined;
    if (cfg.customTriggers !== undefined) {
      if (!Array.isArray(cfg.customTriggers)) {
        throw new Error("customTriggers must be an array of strings");
      }
      customTriggers = cfg.customTriggers.map((trigger, index) => {
        if (typeof trigger !== "string") {
          throw new Error(`customTriggers.${index} must be a string`);
        }
        const normalized = trigger.trim();
        if (!normalized) {
          throw new Error(`customTriggers.${index} must not be empty`);
        }
        if (normalized.length > 100) {
          throw new Error(`customTriggers.${index} must be at most 100 characters`);
        }
        return normalized;
      });
      if (customTriggers.length > 50) {
        throw new Error("customTriggers must include at most 50 entries");
      }
    }

    const dreaming =
      cfg.dreaming === undefined
        ? undefined
        : cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming)
          ? (cfg.dreaming as Record<string, unknown>)
          : (() => {
              throw new Error("dreaming config must be an object");
            })();

    const durableInput = cfg.durableMemory;
    if (
      durableInput !== undefined &&
      (!durableInput || typeof durableInput !== "object" || Array.isArray(durableInput))
    ) {
      throw new Error("durableMemory config must be an object");
    }
    const durable = (durableInput ?? {}) as Record<string, unknown>;
    assertAllowedKeys(
      durable,
      [
        "enabled",
        "ledgerPath",
        "startupReconcile",
        "projectionBatch",
        "projectionConcurrency",
        "embeddingTimeoutMs",
        "recallTimeoutMs",
        "recallLimit",
        "recallBudgetChars",
        "consolidation",
      ],
      "durableMemory config",
    );
    const consolidationInput = durable.consolidation;
    if (
      consolidationInput !== undefined &&
      (!consolidationInput ||
        typeof consolidationInput !== "object" ||
        Array.isArray(consolidationInput))
    ) {
      throw new Error("durableMemory.consolidation must be an object");
    }
    const consolidation = (consolidationInput ?? {}) as Record<string, unknown>;
    assertAllowedKeys(
      consolidation,
      [
        "enabled",
        "baseUrl",
        "apiKey",
        "model",
        "timeoutMs",
        "maxInputChars",
        "extractionBatch",
        "extractionConcurrency",
        "summaryBatch",
        "summaryConcurrency",
      ],
      "durableMemory.consolidation config",
    );
    const consolidationEnabled = consolidation.enabled === true;
    const consolidationBaseUrl =
      typeof consolidation.baseUrl === "string" ? resolveEnvVars(consolidation.baseUrl) : undefined;
    const consolidationModel =
      typeof consolidation.model === "string" ? consolidation.model.trim() : "moira/memory";
    if (consolidationEnabled && !consolidationBaseUrl) {
      throw new Error("durableMemory.consolidation.baseUrl is required when enabled");
    }
    if (consolidationEnabled && !consolidationModel) {
      throw new Error("durableMemory.consolidation.model is required when enabled");
    }
    const durableMemory = {
      // Opt-in at the plugin boundary so an upstream install never migrates a
      // production memory store merely by updating packages. Finn/Jake
      // provisioner policy enables this explicitly and treats disablement as
      // configuration drift.
      enabled: durable.enabled === true,
      ledgerPath:
        typeof durable.ledgerPath === "string"
          ? resolveEnvVars(durable.ledgerPath)
          : DEFAULT_DURABLE_LEDGER_PATH,
      startupReconcile: durable.startupReconcile !== false,
      projectionBatch: resolveBoundedIntegerConfig({
        value: durable.projectionBatch,
        fallback: 32,
        min: 1,
        max: 256,
        label: "durableMemory.projectionBatch",
      }),
      projectionConcurrency: resolveBoundedIntegerConfig({
        value: durable.projectionConcurrency,
        fallback: 4,
        min: 1,
        max: 16,
        label: "durableMemory.projectionConcurrency",
      }),
      embeddingTimeoutMs: resolveBoundedIntegerConfig({
        value: durable.embeddingTimeoutMs,
        fallback: 15_000,
        min: 1_000,
        max: 120_000,
        label: "durableMemory.embeddingTimeoutMs",
      }),
      recallTimeoutMs: resolveBoundedIntegerConfig({
        value: durable.recallTimeoutMs,
        fallback: DEFAULT_DURABLE_RECALL_TIMEOUT_MS,
        min: 100,
        max: 30_000,
        label: "durableMemory.recallTimeoutMs",
      }),
      recallLimit: resolveBoundedIntegerConfig({
        value: durable.recallLimit,
        fallback: DEFAULT_DURABLE_RECALL_LIMIT,
        min: 1,
        max: 20,
        label: "durableMemory.recallLimit",
      }),
      recallBudgetChars: resolveBoundedIntegerConfig({
        value: durable.recallBudgetChars,
        fallback: DEFAULT_DURABLE_RECALL_BUDGET_CHARS,
        min: 500,
        max: 20_000,
        label: "durableMemory.recallBudgetChars",
      }),
      consolidation: {
        enabled: consolidationEnabled,
        ...(consolidationBaseUrl ? { baseUrl: consolidationBaseUrl } : {}),
        ...(typeof consolidation.apiKey === "string"
          ? { apiKey: resolveEnvVars(consolidation.apiKey) }
          : {}),
        model: consolidationModel,
        timeoutMs: resolveBoundedIntegerConfig({
          value: consolidation.timeoutMs,
          fallback: 60_000,
          min: 1_000,
          max: 300_000,
          label: "durableMemory.consolidation.timeoutMs",
        }),
        maxInputChars: resolveBoundedIntegerConfig({
          value: consolidation.maxInputChars,
          fallback: 24_000,
          min: 1_000,
          max: 100_000,
          label: "durableMemory.consolidation.maxInputChars",
        }),
        extractionBatch: resolveBoundedIntegerConfig({
          value: consolidation.extractionBatch,
          fallback: 8,
          min: 1,
          max: 64,
          label: "durableMemory.consolidation.extractionBatch",
        }),
        extractionConcurrency: resolveBoundedIntegerConfig({
          value: consolidation.extractionConcurrency,
          fallback: 2,
          min: 1,
          max: 8,
          label: "durableMemory.consolidation.extractionConcurrency",
        }),
        summaryBatch: resolveBoundedIntegerConfig({
          value: consolidation.summaryBatch,
          fallback: 4,
          min: 1,
          max: 32,
          label: "durableMemory.consolidation.summaryBatch",
        }),
        summaryConcurrency: resolveBoundedIntegerConfig({
          value: consolidation.summaryConcurrency,
          fallback: 2,
          min: 1,
          max: 8,
          label: "durableMemory.consolidation.summaryConcurrency",
        }),
      },
    };

    // Parse storageOptions (object with string values)
    let storageOptions: Record<string, string> | undefined;
    const storageOpts = cfg.storageOptions as Record<string, unknown> | undefined;
    if (storageOpts !== undefined && storageOpts !== null) {
      if (!storageOpts || typeof storageOpts !== "object" || Array.isArray(storageOpts)) {
        throw new Error("storageOptions must be an object");
      }
      storageOptions = {};
      // Validate all values are strings
      for (const [key, valueLocal] of Object.entries(storageOpts)) {
        if (typeof valueLocal !== "string") {
          throw new Error(`storageOptions.${key} must be a string`);
        }
        storageOptions[key] = resolveEnvVars(valueLocal);
      }
    }

    return {
      embedding: {
        provider,
        model,
        apiKey: typeof embedding.apiKey === "string" ? resolveEnvVars(embedding.apiKey) : undefined,
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions,
      },
      dreaming,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars,
      ...(customTriggers ? { customTriggers } : {}),
      recallMaxChars,
      ...(storageOptions ? { storageOptions } : {}),
      durableMemory,
    };
  },
  uiHints: {
    "embedding.provider": {
      label: "Embedding Provider",
      placeholder: "openai",
      help: "Memory embedding provider adapter to use (for example openai, github-copilot, ollama)",
    },
    "embedding.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      placeholder: "sk-proj-...",
      help: "Optional API key override for OpenAI-compatible embeddings; omit to use configured provider auth",
    },
    "embedding.baseUrl": {
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
      help: "Optional provider or OpenAI-compatible embedding endpoint base URL",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Dimensions",
      placeholder: "1536",
      help: "Vector dimensions for custom models (required for non-standard models)",
      advanced: true,
    },
    "embedding.model": {
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
      help: "OpenAI embedding model to use",
    },
    dbPath: {
      label: "Database Path",
      placeholder: "~/.openclaw/memory/lancedb",
      advanced: true,
      help: "Local filesystem path or cloud storage URI (s3://, gs://) for LanceDB database",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    captureMaxChars: {
      label: "Capture Max Chars",
      help: "Maximum message length eligible for auto-capture",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
    customTriggers: {
      label: "Custom Triggers",
      help: "Literal phrases that should make auto-capture consider a message memory-worthy",
      advanced: true,
    },
    recallMaxChars: {
      label: "Recall Query Max Chars",
      help: "Maximum prompt/query length embedded for memory recall. Lower for small local embedding models.",
      advanced: true,
      placeholder: String(DEFAULT_RECALL_MAX_CHARS),
    },
    storageOptions: {
      label: "Storage Options",
      sensitive: true,
      advanced: true,
      help: "Storage configuration options (access_key, secret_key, endpoint, etc.); supports ${ENV_VAR} values",
    },
    "durableMemory.enabled": {
      label: "Durable Memory V2",
      help: "Append every turn to the transactional ledger and use scalable hybrid retrieval",
    },
    "durableMemory.ledgerPath": {
      label: "Durable Ledger Path",
      placeholder: "~/.openclaw/memory/ledger.sqlite3",
      advanced: true,
    },
    "durableMemory.startupReconcile": {
      label: "Reconcile Transcripts on Startup",
      help: "Backfill only transcript bytes not already committed to the durable ledger",
      advanced: true,
    },
    "durableMemory.consolidation.enabled": {
      label: "Semantic Consolidation",
      help: "Asynchronously extract temporal facts and refresh hierarchical summaries",
      advanced: true,
    },
    "durableMemory.consolidation.baseUrl": {
      label: "Consolidation Base URL",
      placeholder: "https://coordinator.example/v1",
      advanced: true,
    },
    "durableMemory.consolidation.apiKey": {
      label: "Consolidation API Key",
      sensitive: true,
      advanced: true,
    },
    "durableMemory.consolidation.model": {
      label: "Consolidation Model Route",
      placeholder: "moira/memory",
      advanced: true,
    },
  },
};
