// Searxng helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/extension-shared";
import { normalizeSecretInput, resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";

const SEARXNG_BASE_URL_ENV_VAR = "SEARXNG_BASE_URL";
const SEARXNG_BASE_URL_PATH = "plugins.entries.searxng.config.webSearch.baseUrl";

type SearxngPluginConfig = {
  webSearch?: {
    baseUrl?: unknown;
    categories?: string;
    language?: string;
  };
};

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeBaseUrl(value: unknown): string | undefined {
  return normalizeSecretInput(value)?.replace(/\/+$/u, "") || undefined;
}

type ConfiguredBaseUrlResolution =
  | { status: "available"; value: string }
  | { status: "missing" }
  | { status: "blocked" };

function resolveConfiguredBaseUrl(
  value: unknown,
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): ConfiguredBaseUrlResolution {
  const resolved = resolveSecretInputString({
    value,
    path: SEARXNG_BASE_URL_PATH,
    defaults: config?.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    const normalized = normalizeBaseUrl(resolved.value);
    return normalized ? { status: "available", value: normalized } : { status: "missing" };
  }
  if (resolved.status === "missing") {
    // A non-string value at this path is an invalid explicit input, not an absent value.
    return value !== undefined && value !== null && typeof value !== "string"
      ? { status: "blocked" }
      : { status: "missing" };
  }
  if (resolved.ref.source !== "env") {
    return { status: "blocked" };
  }
  const envVarName = resolved.ref.id.trim();
  if (
    envVarName !== SEARXNG_BASE_URL_ENV_VAR ||
    !canResolveEnvSecretRefInReadOnlyPath({
      cfg: config,
      provider: resolved.ref.provider,
      id: envVarName,
    })
  ) {
    return { status: "blocked" };
  }
  const normalized = normalizeBaseUrl(env[envVarName]);
  return normalized ? { status: "available", value: normalized } : { status: "blocked" };
}

function resolveSearxngWebSearchConfig(
  config?: OpenClawConfig,
): SearxngPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.searxng?.config as SearxngPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveSearxngBaseUrl(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const webSearch = resolveSearxngWebSearchConfig(config);
  const resolved = resolveConfiguredBaseUrl(webSearch?.baseUrl, config, env);
  if (resolved.status === "available") {
    return resolved.value;
  }
  if (resolved.status === "blocked") {
    return undefined;
  }
  return normalizeBaseUrl(env[SEARXNG_BASE_URL_ENV_VAR]);
}

export function resolveSearxngCategories(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.categories);
}

export function resolveSearxngLanguage(config?: OpenClawConfig): string | undefined {
  return normalizeTrimmedString(resolveSearxngWebSearchConfig(config)?.language);
}
