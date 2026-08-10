import crypto from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { normalizeE164 } from "../utils.js";

export const COMMUNICATION_IDENTITY_REGISTRY_VERSION = 1 as const;
export const COMMUNICATION_IDENTITY_REGISTRY_FILE = "communication-identities.json";
export const COMMUNICATION_IDENTITY_LOCK_OPTIONS = {
  retries: { retries: 12, factor: 1.7, minTimeout: 50, maxTimeout: 2_000, randomize: true },
  stale: 30_000,
} as const;
export const COMMUNICATION_QUARANTINE_AGENT_ID = "communication-quarantine";

const MEMBER_AGENT_PREFIX = "person-";
const PHONE_CHANNELS = new Set(["signal", "whatsapp", "imessage", "bluebubbles", "sms"]);

export function communicationChannelRequiresPhoneIdentity(channel: string): boolean {
  return PHONE_CHANNELS.has(normalizeLowercaseStringOrEmpty(channel));
}

export type CommunicationIdentityEndpoint = {
  channel: string;
  accountId: string;
  peerKind: "direct";
  peerId: string;
  linkedAt: string;
};

export type CommunicationIdentity = {
  id: string;
  canonicalKind: "phone" | "channel-peer";
  /** Present only for phone-backed identities; registry file is mode 0600. */
  phone?: string;
  memberAgentId: string;
  workspace: string;
  agentDir: string;
  createdAt: string;
  updatedAt: string;
  endpoints: CommunicationIdentityEndpoint[];
};

export type CommunicationIdentityRegistry = {
  version: typeof COMMUNICATION_IDENTITY_REGISTRY_VERSION;
  hmacKey: string;
  adminIdentityId: string | null;
  identities: Record<string, CommunicationIdentity>;
  updatedAt: string;
};

export type PlannedCommunicationIdentity = {
  registry: CommunicationIdentityRegistry;
  identity: CommunicationIdentity;
  created: boolean;
  endpointAdded: boolean;
  bootstrappedAdmin: boolean;
  isAdmin: boolean;
};

export type EnsuredCommunicationIdentity = Omit<PlannedCommunicationIdentity, "registry">;

export type PlannedCommunicationAdminTransfer = {
  registry: CommunicationIdentityRegistry;
  identity: CommunicationIdentity;
  created: boolean;
};

export class CommunicationIdentityPhoneRequiredError extends Error {
  readonly code = "COMMUNICATION_IDENTITY_PHONE_REQUIRED";
  readonly channel: string;

  constructor(channel: string) {
    super(
      `Phone-backed channel "${channel}" requires a canonical E.164 phone identity. ` +
        "Supply --identity-phone when the channel exposes only an opaque UUID/JID.",
    );
    this.name = "CommunicationIdentityPhoneRequiredError";
    this.channel = channel;
  }
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function cloneRegistry(registry: CommunicationIdentityRegistry): CommunicationIdentityRegistry {
  return structuredClone(registry);
}

export function createCommunicationIdentityRegistry(now?: Date): CommunicationIdentityRegistry {
  const registry = {
    version: COMMUNICATION_IDENTITY_REGISTRY_VERSION,
    hmacKey: crypto.randomBytes(32).toString("base64"),
    adminIdentityId: null,
    identities: {},
    updatedAt: nowIso(now),
  };
  registerSecretValueForRedaction(registry.hmacKey);
  return registry;
}

function isStrictE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

function looksPhoneLike(value: string): boolean {
  const trimmed = value.trim();
  return /^\+?[\d\s().-]{7,24}$/.test(trimmed) && /\d/.test(trimmed);
}

export function normalizeCommunicationPhone(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || !looksPhoneLike(raw)) {
    return null;
  }
  const normalized = normalizeE164(raw);
  return isStrictE164(normalized) ? normalized : null;
}

function canonicalIdentityKey(params: {
  channel: string;
  accountId: string;
  peerId: string;
  identityPhone?: string | null;
}): { key: string; kind: CommunicationIdentity["canonicalKind"]; phone?: string } {
  const explicitPhone = normalizeCommunicationPhone(params.identityPhone);
  const requiresPhone = communicationChannelRequiresPhoneIdentity(params.channel);
  const inferredPhone = requiresPhone ? normalizeCommunicationPhone(params.peerId) : null;
  const phone = explicitPhone ?? inferredPhone;
  if (phone) {
    return { key: `tel:${phone}`, kind: "phone", phone };
  }
  if (requiresPhone) {
    throw new CommunicationIdentityPhoneRequiredError(params.channel);
  }
  return {
    key: `channel-peer:${params.channel}:${params.accountId}:${params.peerId}`,
    kind: "channel-peer",
  };
}

function identityDigest(registry: CommunicationIdentityRegistry, canonicalKey: string): string {
  const secret = Buffer.from(registry.hmacKey, "base64");
  if (secret.length < 32) {
    throw new Error("Communication identity registry HMAC key is invalid.");
  }
  return crypto.createHmac("sha256", secret).update(canonicalKey).digest("hex");
}

export function communicationIdentityMemberPaths(stateDir: string, identityId: string) {
  const root = path.join(path.resolve(stateDir), "communication-identities", identityId);
  return {
    workspace: path.join(root, "workspace"),
    agentDir: path.join(root, "agent"),
  };
}

function endpointKey(
  endpoint: Pick<CommunicationIdentityEndpoint, "channel" | "accountId" | "peerKind" | "peerId">,
): string {
  return `${endpoint.channel}\0${endpoint.accountId}\0${endpoint.peerKind}\0${endpoint.peerId}`;
}

export function planCommunicationIdentityApproval(params: {
  registry?: CommunicationIdentityRegistry;
  stateDir: string;
  channel: string;
  accountId?: string | null;
  peerId: string;
  identityPhone?: string | null;
  now?: Date;
  allowFirstPhoneAdmin?: boolean;
}): PlannedCommunicationIdentity {
  const registry = cloneRegistry(
    params.registry ?? createCommunicationIdentityRegistry(params.now),
  );
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const peerId = params.peerId.trim();
  if (!channel || !peerId) {
    throw new Error("Communication identity channel and peer id are required.");
  }
  const canonical = canonicalIdentityKey({
    channel,
    accountId,
    peerId,
    identityPhone: params.identityPhone,
  });
  const digest = identityDigest(registry, canonical.key);
  const identityId = `id-${digest.slice(0, 24)}`;
  const timestamp = nowIso(params.now);
  let identity = registry.identities[identityId];
  const created = !identity;
  if (!identity) {
    const paths = communicationIdentityMemberPaths(params.stateDir, identityId);
    identity = {
      id: identityId,
      canonicalKind: canonical.kind,
      ...(canonical.phone ? { phone: canonical.phone } : {}),
      memberAgentId: `${MEMBER_AGENT_PREFIX}${digest.slice(0, 16)}`,
      workspace: paths.workspace,
      agentDir: paths.agentDir,
      createdAt: timestamp,
      updatedAt: timestamp,
      endpoints: [],
    };
  } else if (canonical.phone && identity.phone && canonical.phone !== identity.phone) {
    throw new Error("Communication identity digest collision detected.");
  }

  const endpoint: CommunicationIdentityEndpoint = {
    channel,
    accountId,
    peerKind: "direct",
    peerId,
    linkedAt: timestamp,
  };
  const key = endpointKey(endpoint);
  for (const candidate of Object.values(registry.identities)) {
    if (
      candidate.id !== identityId &&
      candidate.endpoints.some((entry) => endpointKey(entry) === key)
    ) {
      throw new Error(
        `Communication endpoint is already bound to another isolated identity (${candidate.id}).`,
      );
    }
  }
  const endpointAdded = !identity.endpoints.some((entry) => endpointKey(entry) === key);
  if (endpointAdded) {
    identity.endpoints.push(endpoint);
  }
  identity.endpoints = identity.endpoints.toSorted((left, right) =>
    endpointKey(left).localeCompare(endpointKey(right)),
  );
  identity.updatedAt = timestamp;
  registry.identities[identityId] = identity;

  const bootstrappedAdmin =
    !registry.adminIdentityId &&
    canonical.kind === "phone" &&
    (params.allowFirstPhoneAdmin ?? true);
  if (bootstrappedAdmin) {
    registry.adminIdentityId = identityId;
  }
  registry.updatedAt = timestamp;
  return {
    registry,
    identity,
    created,
    endpointAdded,
    bootstrappedAdmin,
    isAdmin: registry.adminIdentityId === identityId,
  };
}

export function planCommunicationAdminTransfer(params: {
  registry: CommunicationIdentityRegistry;
  stateDir: string;
  phone: string;
  now?: Date;
}): PlannedCommunicationAdminTransfer {
  const phone = normalizeCommunicationPhone(params.phone);
  if (!phone) {
    throw new Error("Admin phone must be a valid E.164 number.");
  }
  const planned = planCommunicationIdentityApproval({
    registry: params.registry,
    stateDir: params.stateDir,
    channel: "admin-reservation",
    accountId: DEFAULT_ACCOUNT_ID,
    peerId: phone,
    identityPhone: phone,
    allowFirstPhoneAdmin: false,
    now: params.now,
  });
  planned.identity.endpoints = planned.identity.endpoints.filter(
    (endpoint) => endpoint.channel !== "admin-reservation",
  );
  planned.registry.adminIdentityId = planned.identity.id;
  planned.registry.identities[planned.identity.id] = planned.identity;
  planned.registry.updatedAt = nowIso(params.now);
  return {
    registry: planned.registry,
    identity: planned.identity,
    created: planned.created,
  };
}

export function seedCommunicationIdentityRegistryFromConfigOwners(params: {
  registry: CommunicationIdentityRegistry;
  config: OpenClawConfig;
  stateDir: string;
  now?: Date;
}): CommunicationIdentityRegistry {
  let registry = cloneRegistry(params.registry);
  // This is a one-time migration path for pre-registry installations. Once the
  // durable registry contains any identity, projected ownerAllowFrom entries
  // are outputs of this system rather than legacy inputs. Re-importing them
  // would lose account scope and could create a privileged "default" endpoint.
  if (registry.adminIdentityId || Object.keys(registry.identities).length > 0) {
    return registry;
  }
  const owners = Array.isArray(params.config.commands?.ownerAllowFrom)
    ? params.config.commands.ownerAllowFrom
    : [];
  for (const rawOwner of owners) {
    const value = String(rawOwner ?? "").trim();
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) {
      continue;
    }
    const channel = value.slice(0, separator);
    const peerId = value.slice(separator + 1);
    const phone = normalizeCommunicationPhone(peerId);
    if (!phone) {
      continue;
    }
    const planned = planCommunicationIdentityApproval({
      registry,
      stateDir: params.stateDir,
      channel,
      accountId: DEFAULT_ACCOUNT_ID,
      peerId,
      identityPhone: phone,
      allowFirstPhoneAdmin: false,
      now: params.now,
    });
    registry = planned.registry;
    if (!registry.adminIdentityId) {
      registry.adminIdentityId = planned.identity.id;
    }
  }
  return registry;
}

function isEndpoint(value: unknown): value is CommunicationIdentityEndpoint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.channel === "string" &&
    value.channel.length > 0 &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    value.peerKind === "direct" &&
    typeof value.peerId === "string" &&
    value.peerId.length > 0 &&
    typeof value.linkedAt === "string"
  );
}

function isIdentity(value: unknown): value is CommunicationIdentity {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    /^id-[a-f0-9]{24}$/.test(value.id) &&
    (value.canonicalKind === "phone" || value.canonicalKind === "channel-peer") &&
    (value.phone === undefined || (typeof value.phone === "string" && isStrictE164(value.phone))) &&
    typeof value.memberAgentId === "string" &&
    /^person-[a-f0-9]{16}$/.test(value.memberAgentId) &&
    typeof value.workspace === "string" &&
    path.isAbsolute(value.workspace) &&
    typeof value.agentDir === "string" &&
    path.isAbsolute(value.agentDir) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.endpoints) &&
    value.endpoints.every(isEndpoint)
  );
}

export function isCommunicationIdentityRegistry(
  value: unknown,
): value is CommunicationIdentityRegistry {
  if (!isRecord(value) || !isRecord(value.identities)) {
    return false;
  }
  const candidate = value as Partial<CommunicationIdentityRegistry>;
  const identities = Object.entries(value.identities);
  if (
    !(
      candidate.version === COMMUNICATION_IDENTITY_REGISTRY_VERSION &&
      typeof candidate.hmacKey === "string" &&
      (candidate.adminIdentityId === null || typeof candidate.adminIdentityId === "string") &&
      typeof candidate.updatedAt === "string" &&
      identities.every(([key, identity]) => isIdentity(identity) && identity.id === key)
    )
  ) {
    return false;
  }
  let secret: Buffer;
  try {
    secret = Buffer.from(candidate.hmacKey, "base64");
  } catch {
    return false;
  }
  if (secret.length < 32) {
    return false;
  }
  if (candidate.adminIdentityId && !(candidate.adminIdentityId in value.identities)) {
    return false;
  }
  const endpointOwners = new Map<string, string>();
  const agentOwners = new Set<string>();
  for (const [, identityValue] of identities) {
    const identity = identityValue as CommunicationIdentity;
    if (agentOwners.has(identity.memberAgentId)) {
      return false;
    }
    agentOwners.add(identity.memberAgentId);
    for (const endpoint of identity.endpoints) {
      const key = endpointKey(endpoint);
      const owner = endpointOwners.get(key);
      if (owner && owner !== identity.id) {
        return false;
      }
      endpointOwners.set(key, identity.id);
    }
  }
  return true;
}

/** Test-only registry constructor; callers still receive an opaque random key. */
export function createCommunicationIdentityRegistryForTest(
  now = new Date("2026-01-01T00:00:00.000Z"),
): CommunicationIdentityRegistry {
  return createCommunicationIdentityRegistry(now);
}
