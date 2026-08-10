import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { redactSensitiveText } from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { parseSessionDeliveryRoute, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  COMMUNICATION_IDENTITY_REGISTRY_FILE,
  COMMUNICATION_QUARANTINE_AGENT_ID,
  isCommunicationIdentityRegistry,
  type CommunicationIdentity,
  type CommunicationIdentityEndpoint,
  type CommunicationIdentityRegistry,
} from "./communication-identity-registry.js";

export type SanitizedCommunicationAccess = {
  endpointType: string;
  boundState: "bound" | "unbound" | "local";
  routingState: "admin" | "isolated" | "quarantine" | "unbound" | "local";
  authState: "authorized" | "pending" | "unknown" | "local";
  redactedIdentifier?: string;
  label: string;
  createdAt?: string;
  linkedAt?: string;
  updatedAt?: string;
  evidenceRefs: string[];
};

export type SanitizedCommunicationInventory = {
  entries: SanitizedCommunicationAccess[];
};

function safeEndpointType(value: string | undefined): string {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]/g, "") ?? "";
  return normalized.slice(0, 32) || "unknown";
}

function safeTimestamp(value: string | number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function redactIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll(/[^a-zA-Z0-9]/g, "") ?? "";
  if (!normalized) {
    return undefined;
  }
  return `***${normalized.slice(-4).padStart(4, "*")}`;
}

function evidenceRef(kind: "endpoint" | "session", parts: readonly string[]): string {
  const digest = crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
  return `communication-${kind}:${digest.slice(0, 24)}`;
}

function safeBoundLabel(entry: SessionEntry, peerIds: readonly string[]): string | undefined {
  const candidates = [entry.origin?.label, entry.displayName, entry.label];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = candidate.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().slice(0, 80);
    if (!normalized || !/[\p{L}\p{N}]/u.test(normalized)) {
      continue;
    }
    if (!/^[\p{L}\p{M}\p{N} .,'’()_-]{1,80}$/u.test(normalized)) {
      continue;
    }
    if (/\+?\d(?:[\d ().-]*\d){6,}/u.test(normalized)) {
      continue;
    }
    if (peerIds.some((peerId) => peerId.length > 0 && normalized.includes(peerId))) {
      continue;
    }
    if (redactSensitiveText(normalized, { mode: "tools" }) !== normalized) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function sanitizeBoundEndpoint(params: {
  identity: CommunicationIdentity;
  endpoint: CommunicationIdentityEndpoint;
  isAdmin: boolean;
  label?: string;
}): SanitizedCommunicationAccess {
  const redactedIdentifier = redactIdentifier(params.identity.phone ?? params.endpoint.peerId);
  const createdAt = safeTimestamp(params.identity.createdAt);
  const linkedAt = safeTimestamp(params.endpoint.linkedAt);
  const updatedAt = safeTimestamp(params.identity.updatedAt);
  return {
    endpointType: safeEndpointType(params.endpoint.channel),
    boundState: "bound",
    routingState: params.isAdmin ? "admin" : "isolated",
    authState: "authorized",
    ...(redactedIdentifier ? { redactedIdentifier } : {}),
    label: params.label ?? (params.isAdmin ? "Administrator" : "Isolated member"),
    ...(createdAt ? { createdAt } : {}),
    ...(linkedAt ? { linkedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    evidenceRefs: [
      evidenceRef("endpoint", [
        params.identity.id,
        params.endpoint.channel,
        params.endpoint.accountId,
        params.endpoint.linkedAt,
      ]),
    ],
  };
}

export function sanitizeCommunicationIdentityInventory(
  registry: Pick<CommunicationIdentityRegistry, "adminIdentityId" | "identities"> | undefined,
): SanitizedCommunicationInventory {
  if (!registry) {
    return { entries: [] };
  }
  const entries = Object.values(registry.identities).flatMap((identity) =>
    identity.endpoints.map((endpoint) =>
      sanitizeBoundEndpoint({
        identity,
        endpoint,
        isAdmin: identity.id === registry.adminIdentityId,
      }),
    ),
  );
  return {
    entries: entries.toSorted((left, right) =>
      [left.endpointType, left.redactedIdentifier ?? "", left.evidenceRefs[0] ?? ""]
        .join("\0")
        .localeCompare(
          [right.endpointType, right.redactedIdentifier ?? "", right.evidenceRefs[0] ?? ""].join(
            "\0",
          ),
        ),
    ),
  };
}

async function readProtectedRegistry(
  env: NodeJS.ProcessEnv,
): Promise<CommunicationIdentityRegistry | undefined> {
  const registryPath = path.join(
    resolveStateDir(env),
    "identity",
    COMMUNICATION_IDENTITY_REGISTRY_FILE,
  );
  try {
    const stat = await fs.promises.lstat(registryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("unsafe registry path");
    }
    const parsed: unknown = JSON.parse(await fs.promises.readFile(registryPath, "utf8"));
    if (!isCommunicationIdentityRegistry(parsed)) {
      throw new Error("invalid registry");
    }
    registerSecretValueForRedaction(parsed.hmacKey);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    // JSON parser and filesystem errors may contain raw registry fragments or paths.
    // oxlint-disable-next-line eslint/preserve-caught-error -- the cause is intentionally secret-bearing
    throw new Error("Protected communication identity registry is unavailable.");
  }
}

export async function loadCommunicationIdentityInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SanitizedCommunicationInventory> {
  return sanitizeCommunicationIdentityInventory(await readProtectedRegistry(env));
}

type SessionOriginSource = {
  channel?: string;
  accountId?: string;
  peerIds: string[];
};

function readSessionOriginSource(entry: SessionEntry, sessionKey: string): SessionOriginSource {
  const route = parseSessionDeliveryRoute(sessionKey);
  const channel =
    entry.origin?.provider ?? entry.channel ?? entry.lastChannel ?? route?.channel ?? undefined;
  const accountId = entry.origin?.accountId ?? entry.lastAccountId ?? route?.accountId;
  const peerIds = [
    entry.origin?.nativeDirectUserId,
    entry.origin?.from,
    entry.deliveryContext?.to,
    entry.lastTo,
    route?.peerId,
  ].flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
  return { channel, accountId, peerIds: [...new Set(peerIds)] };
}

function findBoundEndpoint(params: {
  registry: Pick<CommunicationIdentityRegistry, "adminIdentityId" | "identities">;
  source: SessionOriginSource;
}): { identity: CommunicationIdentity; endpoint: CommunicationIdentityEndpoint } | undefined {
  const channel = params.source.channel?.trim().toLowerCase();
  if (!channel || params.source.peerIds.length === 0) {
    return undefined;
  }
  const peerIds = new Set(params.source.peerIds);
  const matches = Object.values(params.registry.identities).flatMap((identity) =>
    identity.endpoints.flatMap((endpoint) => {
      const channelMatches = endpoint.channel.trim().toLowerCase() === channel;
      const accountMatches =
        !params.source.accountId || endpoint.accountId === params.source.accountId;
      const peerMatches =
        peerIds.has(endpoint.peerId) || Boolean(identity.phone && peerIds.has(identity.phone));
      return channelMatches && accountMatches && peerMatches ? [{ identity, endpoint }] : [];
    }),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  const owners = new Set(matches.map((match) => match.identity.id));
  return owners.size === 1 ? matches[0] : undefined;
}

export function sanitizeCommunicationSessionOrigin(params: {
  registry?: Pick<CommunicationIdentityRegistry, "adminIdentityId" | "identities">;
  entry: SessionEntry;
  sessionKey: string;
}): SanitizedCommunicationAccess {
  const source = readSessionOriginSource(params.entry, params.sessionKey);
  const match = params.registry
    ? findBoundEndpoint({ registry: params.registry, source })
    : undefined;
  if (match && params.registry) {
    return sanitizeBoundEndpoint({
      ...match,
      isAdmin: match.identity.id === params.registry.adminIdentityId,
      label: safeBoundLabel(params.entry, [
        ...source.peerIds,
        ...(match.identity.phone ? [match.identity.phone] : []),
      ]),
    });
  }

  const requesterAgentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const isQuarantine = requesterAgentId === COMMUNICATION_QUARANTINE_AGENT_ID;
  const endpointType = safeEndpointType(source.channel);
  const isLocal = endpointType === "unknown" && source.peerIds.length === 0;
  const redacted = redactIdentifier(source.peerIds[0]);
  const createdAt = safeTimestamp(params.entry.sessionStartedAt);
  const updatedAt = safeTimestamp(params.entry.updatedAt);
  return {
    endpointType: isLocal ? "local" : endpointType,
    boundState: isLocal ? "local" : "unbound",
    routingState: isLocal ? "local" : isQuarantine ? "quarantine" : "unbound",
    authState: isLocal ? "local" : isQuarantine ? "pending" : "unknown",
    ...(redacted ? { redactedIdentifier: redacted } : {}),
    label: isLocal ? "Local session" : isQuarantine ? "Pairing quarantine" : "Unbound origin",
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    evidenceRefs: [
      evidenceRef("session", [
        params.entry.sessionId,
        String(params.entry.updatedAt),
        endpointType,
      ]),
    ],
  };
}

export async function loadCommunicationSessionOrigin(params: {
  entry: SessionEntry;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SanitizedCommunicationAccess> {
  return sanitizeCommunicationSessionOrigin({
    registry: await readProtectedRegistry(params.env ?? process.env),
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
}
