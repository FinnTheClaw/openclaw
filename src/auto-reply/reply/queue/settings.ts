import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizePersistedQueueMode } from "./normalize.js";
import { DEFAULT_QUEUE_CAP, DEFAULT_QUEUE_DEBOUNCE_MS, DEFAULT_QUEUE_DROP } from "./state.js";
import type { QueueSettings, ResolveQueueSettingsParams } from "./types.js";

export function normalizeQueueDebounce(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function resolveChannelQueueOverride<T>(
  values: Readonly<Record<string, T>> | undefined,
  channelKey: string | undefined,
): T | undefined {
  if (!values || !channelKey) {
    return undefined;
  }
  // Keep canonical keys authoritative; otherwise use the first authored matching spelling.
  if (Object.hasOwn(values, channelKey)) {
    return values[channelKey];
  }
  for (const [key, value] of Object.entries(values)) {
    if (normalizeOptionalLowercaseString(key) === channelKey) {
      return value;
    }
  }
  return undefined;
}

export function resolveQueueSettingsCore(params: ResolveQueueSettingsParams): QueueSettings {
  const channelKey = normalizeOptionalLowercaseString(params.channel);
  const queueCfg = params.cfg.messages?.queue;
  const providerModeRaw = resolveChannelQueueOverride(queueCfg?.byChannel, channelKey);
  const resolvedMode =
    params.inlineMode ??
    normalizePersistedQueueMode(params.sessionEntry?.queueMode) ??
    providerModeRaw ??
    queueCfg?.mode ??
    "steer";
  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    resolveChannelQueueOverride(queueCfg?.debounceMsByChannel, channelKey) ??
    params.pluginDebounceMs ??
    DEFAULT_QUEUE_DEBOUNCE_MS;
  const capRaw =
    params.inlineOptions?.cap ??
    params.sessionEntry?.queueCap ??
    queueCfg?.cap ??
    DEFAULT_QUEUE_CAP;
  const dropRaw =
    params.inlineOptions?.dropPolicy ??
    params.sessionEntry?.queueDrop ??
    queueCfg?.drop ??
    DEFAULT_QUEUE_DROP;
  return {
    mode: resolvedMode,
    debounceMs: Math.max(0, debounceRaw),
    cap: Math.max(1, Math.floor(capRaw)),
    dropPolicy: dropRaw,
  };
}
