import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isOpenAIGptLiveApiModel, isOpenAIGptLiveModel } from "./realtime-quicksilver.js";

export function resolveConfiguredLiveQuicksilverModel(): string | undefined {
  const realtime = getRuntimeConfig().talk?.realtime;
  const directModel = realtime?.model?.trim();
  const providerEntries = Object.entries(realtime?.providers ?? {});
  const explicitProviderId = realtime?.provider?.trim().toLowerCase();
  const soleProviderId =
    providerEntries.length === 1 ? providerEntries[0]?.[0].trim().toLowerCase() : undefined;
  const selectedProviderId = explicitProviderId ?? soleProviderId;
  if (selectedProviderId && selectedProviderId !== "openai") {
    return undefined;
  }
  if (directModel) {
    return isOpenAIGptLiveModel(directModel) && !isOpenAIGptLiveApiModel(directModel)
      ? directModel
      : undefined;
  }
  const providerConfig = selectedProviderId
    ? providerEntries.find(([id]) => id.trim().toLowerCase() === selectedProviderId)?.[1]
    : undefined;
  const providerModel = providerConfig?.model;
  const normalizedProviderModel =
    typeof providerModel === "string" ? providerModel.trim() : undefined;
  return isOpenAIGptLiveModel(normalizedProviderModel) &&
    !isOpenAIGptLiveApiModel(normalizedProviderModel)
    ? normalizedProviderModel
    : undefined;
}
