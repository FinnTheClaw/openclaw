// Shared runtime-equivalent DM resolution for the current Doctor scan owner.
import {
  resolveChannelDmAllowFrom,
  resolveChannelDmPolicy,
} from "../../../channels/plugins/dm-access.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { DoctorAccountRecord } from "../types.js";

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
