// Doctor warning builder for allowlist policies that would block every sender.
import {
  resolveChannelDmAllowFrom,
  resolveChannelDmPolicy,
} from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning } from "./channel-doctor.js";

type CollectEmptyAllowlistPolicyWarningsParams = {
  account: DoctorAccountRecord;
  channelName?: string;
  cfg?: OpenClawConfig;
  doctorFixCommand: string;
  parent?: DoctorAccountRecord;
  prefix: string;
  shouldSkipDefaultEmptyGroupAllowlistWarning?: typeof shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning;
};

function usesSenderBasedGroupAllowlist(channelName?: string): boolean {
  return getDoctorChannelCapabilities(channelName).warnOnEmptyGroupSenderAllowlist;
}

function allowsGroupAllowFromFallback(channelName?: string): boolean {
  return getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom;
}

export function resolveDoctorEffectiveDmAllowlist(params: {
  account: DoctorAccountRecord;
  channelName?: string;
  parent?: DoctorAccountRecord;
  prefix: string;
}) {
  const mode = getDoctorChannelCapabilities(params.channelName).dmAllowFromMode;
  const nestedCanonical = mode === "nestedOnly";
  return {
    dmPolicy: resolveChannelDmPolicy({
      account: params.account,
      parent: params.parent,
      mode,
    }),
    effectiveAllowFrom: resolveChannelDmAllowFrom({
      account: params.account,
      parent: params.parent,
      mode,
    }),
    dmPolicyPath: nestedCanonical ? `${params.prefix}.dm.policy` : `${params.prefix}.dmPolicy`,
    allowFromPath: nestedCanonical ? `${params.prefix}.dm.allowFrom` : `${params.prefix}.allowFrom`,
    allowFromLabel: nestedCanonical ? "dm.allowFrom" : "allowFrom",
  };
}

/** Collect DM/group allowlist warnings for one channel or account config record. */
export function collectEmptyAllowlistPolicyWarningsForAccount(
  params: CollectEmptyAllowlistPolicyWarningsParams,
): string[] {
  const warnings: string[] = [];
  const { dmPolicy, effectiveAllowFrom, dmPolicyPath, allowFromPath, allowFromLabel } =
    resolveDoctorEffectiveDmAllowlist({
      account: params.account,
      channelName: params.channelName,
      parent: params.parent,
      prefix: params.prefix,
    });

  if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) {
    warnings.push(
      `- ${dmPolicyPath} is "allowlist" but ${allowFromLabel} is empty — all DMs will be blocked. Add sender IDs to ${allowFromPath}, or run "${params.doctorFixCommand}" to auto-migrate from pairing store when entries exist.`,
    );
  }

  const groupPolicy =
    (params.account.groupPolicy as string | undefined) ??
    (params.parent?.groupPolicy as string | undefined) ??
    undefined;

  if (groupPolicy !== "allowlist" || !usesSenderBasedGroupAllowlist(params.channelName)) {
    return warnings;
  }

  if (
    params.channelName &&
    (
      params.shouldSkipDefaultEmptyGroupAllowlistWarning ??
      shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning
    )({
      account: params.account,
      channelName: params.channelName,
      cfg: params.cfg,
      dmPolicy,
      effectiveAllowFrom,
      parent: params.parent,
      prefix: params.prefix,
    })
  ) {
    return warnings;
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.groupAllowFrom as DoctorAllowFromList | undefined);
  // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
  // unset and falls back to allowFrom.
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const fallbackToAllowFrom = allowsGroupAllowFromFallback(params.channelName);
  const effectiveGroupAllowFrom =
    groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : undefined);

  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return warnings;
  }

  if (fallbackToAllowFrom) {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and ${allowFromLabel}) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${allowFromPath}, or set groupPolicy to "open".`,
    );
  } else {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom, or set groupPolicy to "open".`,
    );
  }

  return warnings;
}
