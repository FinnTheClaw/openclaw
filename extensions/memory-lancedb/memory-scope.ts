import { createHash } from "node:crypto";
import path from "node:path";

const MEMORY_SCOPE_VERSION = "memory-scope-v1";

export type MemoryEvidenceClass =
  | "direct_user"
  | "verified_operator"
  | "assistant_claim"
  | "assistant_reasoning"
  | "tool_observation"
  | "system_context"
  | "workspace_document"
  | "legacy_unverified";

export type TrustedMemoryScopeInput = {
  agentId: string;
  workspaceDir: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
};

export type TrustedMemoryScope = {
  version: typeof MEMORY_SCOPE_VERSION;
  /** Opaque owner used in durable storage instead of a raw agent/person id. */
  storageAgentId: string;
  /** Scope for raw turn material. It never crosses a conversation/session boundary. */
  conversationScope: string;
  /** Scope for evidence-qualified durable facts shared by one canonical principal. */
  principalScope: string;
  workspaceRef: string;
  sessionRef: string;
  accountRef: string;
  conversationRef: string;
  channel: string;
};

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`memory scope ${label} must not be empty`);
  }
  return normalized;
}

function optional(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function digest(label: string, ...parts: string[]): string {
  return `${label}_${createHash("sha256")
    .update([MEMORY_SCOPE_VERSION, ...parts].join("\u0000"))
    .digest("hex")}`;
}

function canonicalWorkspace(workspaceDir: string): string {
  const resolved = path.resolve(required(workspaceDir, "workspaceDir")).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

/**
 * Build a fail-closed storage boundary without persisting channel-local person
 * identifiers. Communication identities already receive one stable agent and
 * workspace across every paired channel, so that pair is the canonical
 * principal seed. Channel/account/conversation/session remain separate opaque
 * boundary dimensions.
 */
export function resolveTrustedMemoryScope(input: TrustedMemoryScopeInput): TrustedMemoryScope {
  const agentId = required(input.agentId, "agentId").toLocaleLowerCase();
  const workspace = canonicalWorkspace(input.workspaceDir);
  const channel = optional(input.channel, "local").toLocaleLowerCase();
  const account = optional(input.accountId, "default");
  const conversation = optional(input.conversationId, "local");
  const session = optional(input.sessionId ?? input.sessionKey, "local");

  if (channel !== "local" && conversation === "local") {
    throw new Error("memory scope refused a channel context without a conversation identity");
  }
  if (channel !== "local" && session === "local") {
    throw new Error("memory scope refused a channel context without a canonical session identity");
  }

  const workspaceRef = digest("workspace", workspace);
  const storageAgentId = digest("principal", agentId, workspaceRef);
  const accountRef = digest("account", storageAgentId, channel, account);
  const conversationRef = digest("conversation", accountRef, conversation);
  const sessionRef = digest("session", conversationRef, session);
  const principalScope = digest("scope_principal", storageAgentId);
  const conversationScope = digest(
    "scope_conversation",
    storageAgentId,
    channel,
    accountRef,
    conversationRef,
    sessionRef,
  );

  return {
    version: MEMORY_SCOPE_VERSION,
    storageAgentId,
    conversationScope,
    principalScope,
    workspaceRef,
    sessionRef,
    accountRef,
    conversationRef,
    channel,
  };
}

export function memoryScopeMetadata(
  scope: TrustedMemoryScope,
  evidenceClass: MemoryEvidenceClass,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    memoryScopeVersion: scope.version,
    memoryScope: scope.conversationScope,
    principalScope: scope.principalScope,
    workspaceRef: scope.workspaceRef,
    accountRef: scope.accountRef,
    conversationRef: scope.conversationRef,
    sessionRef: scope.sessionRef,
    evidenceClass,
  };
}

export function isMemoryScopeCompatible(
  expected: TrustedMemoryScope,
  metadata: Record<string, unknown>,
): boolean {
  return (
    metadata.memoryScopeVersion === expected.version &&
    metadata.workspaceRef === expected.workspaceRef &&
    metadata.accountRef === expected.accountRef &&
    metadata.conversationRef === expected.conversationRef &&
    metadata.sessionRef === expected.sessionRef &&
    metadata.memoryScope === expected.conversationScope &&
    metadata.principalScope === expected.principalScope
  );
}
