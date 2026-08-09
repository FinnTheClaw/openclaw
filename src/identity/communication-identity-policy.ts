import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { AgentBinding, AgentConfig, AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecToolConfig } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  COMMUNICATION_QUARANTINE_AGENT_ID,
  communicationIdentityMemberPaths,
  type CommunicationIdentity,
  type CommunicationIdentityEndpoint,
  type CommunicationIdentityRegistry,
} from "./communication-identity-registry.js";

const MANAGED_BINDING_PREFIX = "communication-identity:";
const MANAGED_LINK_PREFIX = "communication-identity-";

const MEMBER_TOOL_ALLOW = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
  "session_status",
] as const;

const MEMBER_TOOL_DENY = [
  "gateway",
  "nodes",
  "cron",
  "browser",
  "canvas",
  "message",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "agents_list",
  "image",
  "pdf",
  "image_generate",
  "video_generate",
  "music_generate",
] as const;

function execWithMode(params: {
  existing?: ExecToolConfig;
  host: NonNullable<ExecToolConfig["host"]>;
  mode: NonNullable<ExecToolConfig["mode"]>;
  workspaceOnly?: boolean;
}): ExecToolConfig {
  // `mode` is the canonical policy knob and the schema deliberately rejects
  // mixing it with legacy `security` / `ask` fields. Strip inherited legacy
  // values so projecting a previously configured host stays schema-valid.
  const { security: _security, ask: _ask, ...existing } = params.existing ?? {};
  return {
    ...existing,
    host: params.host,
    mode: params.mode,
    ...(params.workspaceOnly === undefined
      ? {}
      : {
          applyPatch: {
            ...existing.applyPatch,
            enabled: true,
            workspaceOnly: params.workspaceOnly,
          },
        }),
  };
}

function managedBinding(binding: AgentBinding): boolean {
  return typeof binding.comment === "string" && binding.comment.startsWith(MANAGED_BINDING_PREFIX);
}

function ownerEntry(endpoint: CommunicationIdentityEndpoint): string {
  return `${endpoint.channel}:${endpoint.peerId}`;
}

function elevatedAllowFrom(endpoints: CommunicationIdentityEndpoint[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const endpoint of endpoints) {
    const current = result[endpoint.channel] ?? [];
    if (!current.includes(endpoint.peerId)) {
      current.push(endpoint.peerId);
    }
    result[endpoint.channel] = current;
  }
  for (const values of Object.values(result)) {
    values.sort((left, right) => left.localeCompare(right));
  }
  return result;
}

function memberAgent(identity: CommunicationIdentity): AgentConfig {
  return {
    id: identity.memberAgentId,
    name: `Private user ${identity.id.slice(-8)}`,
    workspace: identity.workspace,
    agentDir: identity.agentDir,
    skills: [],
    memorySearch: {
      enabled: true,
      sources: ["memory"],
      experimental: { sessionMemory: false },
    },
    subagents: {
      allowAgents: [],
      allowModelOverride: false,
      requireAgentId: true,
    },
    sandbox: {
      mode: "all",
      backend: "docker",
      scope: "agent",
      workspaceAccess: "rw",
      sessionToolsVisibility: "spawned",
      browser: { enabled: false, allowHostControl: false },
      docker: {
        network: "none",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/run"],
        capDrop: ["ALL"],
        pidsLimit: 256,
        memory: "2g",
        memorySwap: "2g",
        cpus: 2,
      },
    },
    tools: {
      profile: "coding",
      allow: [...MEMBER_TOOL_ALLOW],
      deny: [...MEMBER_TOOL_DENY],
      elevated: { enabled: false, allowFrom: {} },
      exec: execWithMode({ host: "sandbox", mode: "full", workspaceOnly: true }),
      fs: { workspaceOnly: true },
      sandbox: {
        tools: {
          allow: [...MEMBER_TOOL_ALLOW],
          deny: [...MEMBER_TOOL_DENY],
        },
      },
    },
  };
}

function quarantineAgent(stateDir: string): AgentConfig {
  const paths = communicationIdentityMemberPaths(stateDir, "quarantine");
  return {
    id: COMMUNICATION_QUARANTINE_AGENT_ID,
    name: "Unbound communication quarantine",
    workspace: paths.workspace,
    agentDir: paths.agentDir,
    skills: [],
    memorySearch: { enabled: false },
    subagents: { allowAgents: [], allowModelOverride: false, requireAgentId: true },
    sandbox: {
      mode: "all",
      backend: "docker",
      scope: "session",
      workspaceAccess: "none",
      sessionToolsVisibility: "spawned",
      browser: { enabled: false, allowHostControl: false },
      docker: { network: "none", readOnlyRoot: true, capDrop: ["ALL"], pidsLimit: 32 },
    },
    tools: {
      profile: "minimal",
      allow: ["session_status"],
      deny: [...MEMBER_TOOL_DENY, "read", "write", "edit", "apply_patch", "exec", "process"],
      elevated: { enabled: false, allowFrom: {} },
      exec: execWithMode({ host: "sandbox", mode: "deny" }),
      fs: { workspaceOnly: true },
      sandbox: { tools: { allow: ["session_status"] } },
    },
  };
}

function mergeManagedAgent(existing: AgentConfig | undefined, managed: AgentConfig): AgentConfig {
  return {
    ...existing,
    ...managed,
    sandbox: managed.sandbox,
    tools: managed.tools,
    skills: managed.skills,
    memorySearch: managed.memorySearch,
    subagents: managed.subagents,
  };
}

/** Pure config projection used by the runtime and adversarial tests. */
export function applyCommunicationIdentityConfig(params: {
  config: OpenClawConfig;
  registry: CommunicationIdentityRegistry;
  stateDir: string;
}): OpenClawConfig {
  const config = structuredClone(params.config);
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(config));
  const identities = Object.values(params.registry.identities).toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
  const adminIdentity = params.registry.adminIdentityId
    ? params.registry.identities[params.registry.adminIdentityId]
    : undefined;
  const adminEndpoints = adminIdentity?.endpoints ?? [];

  config.session = {
    ...config.session,
    dmScope: "per-account-channel-peer",
    identityLinks: {
      ...Object.fromEntries(
        Object.entries(config.session?.identityLinks ?? {}).filter(
          ([key]) => !key.startsWith(MANAGED_LINK_PREFIX),
        ),
      ),
      ...Object.fromEntries(
        identities.map((identity) => [
          `${MANAGED_LINK_PREFIX}${identity.id}`,
          [...new Set(identity.endpoints.map(ownerEntry))].toSorted(),
        ]),
      ),
    },
  };

  const configuredAgents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const byId = new Map(configuredAgents.map((agent) => [normalizeAgentId(agent.id), agent]));
  const defaultAgent = byId.get(defaultAgentId) ?? { id: defaultAgentId, default: true };
  const adminAllow = elevatedAllowFrom(adminEndpoints);
  const unrestrictedDefault: AgentConfig = {
    ...defaultAgent,
    id: defaultAgentId,
    default: true,
    sandbox: { ...defaultAgent.sandbox, mode: "off" },
    tools: {
      ...defaultAgent.tools,
      profile: "full",
      deny: [],
      exec: execWithMode({
        existing: defaultAgent.tools?.exec,
        host: "auto",
        mode: "full",
        workspaceOnly: false,
      }),
      elevated: { enabled: true, allowFrom: adminAllow },
      fs: { workspaceOnly: false },
    },
  };

  const managedAgentIds = new Set([
    COMMUNICATION_QUARANTINE_AGENT_ID,
    ...identities.map((identity) => identity.memberAgentId),
  ]);
  const preservedAgents = configuredAgents.filter(
    (agent) =>
      normalizeAgentId(agent.id) !== defaultAgentId &&
      !managedAgentIds.has(normalizeAgentId(agent.id)),
  );
  const identityAgents = identities.map((identity) =>
    mergeManagedAgent(byId.get(identity.memberAgentId), memberAgent(identity)),
  );
  const quarantine = mergeManagedAgent(
    byId.get(COMMUNICATION_QUARANTINE_AGENT_ID),
    quarantineAgent(params.stateDir),
  );
  config.agents = {
    ...config.agents,
    defaults: {
      ...config.agents?.defaults,
      sandbox: { ...config.agents?.defaults?.sandbox, mode: "off" },
    },
    list: [unrestrictedDefault, ...preservedAgents, ...identityAgents, quarantine],
  };

  config.tools = {
    ...config.tools,
    profile: "full",
    deny: [],
    exec: execWithMode({
      existing: config.tools?.exec,
      host: "auto",
      mode: "full",
      workspaceOnly: false,
    }),
    elevated: { enabled: true, allowFrom: adminAllow },
    fs: { workspaceOnly: false },
  };
  config.commands = {
    ...config.commands,
    ownerAllowFrom: [...new Set(adminEndpoints.map(ownerEntry))].toSorted(),
  };

  const existingBindings = Array.isArray(config.bindings)
    ? config.bindings.filter((binding) => binding.type === "acp" || !managedBinding(binding))
    : [];
  const exactBindings: AgentRouteBinding[] = [];
  const channels = new Set<string>();
  const addChannel = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase();
    if (normalized && normalized !== "*") {
      channels.add(normalized);
    }
  };
  for (const configuredChannel of Object.keys(config.channels ?? {})) {
    addChannel(configuredChannel);
  }
  for (const binding of existingBindings) {
    if (binding.type === "route") {
      addChannel(binding.match.channel);
    }
  }
  for (const identity of identities) {
    const targetAgentId =
      identity.id === params.registry.adminIdentityId ? defaultAgentId : identity.memberAgentId;
    for (const endpoint of identity.endpoints) {
      addChannel(endpoint.channel);
      exactBindings.push({
        type: "route",
        agentId: targetAgentId,
        comment: `${MANAGED_BINDING_PREFIX}${identity.id}`,
        match: {
          channel: endpoint.channel,
          accountId: endpoint.accountId,
          peer: { kind: "direct", id: endpoint.peerId },
        },
        session: { dmScope: "per-account-channel-peer" },
      });
    }
  }
  exactBindings.sort((left, right) =>
    JSON.stringify(left.match).localeCompare(JSON.stringify(right.match)),
  );
  const quarantineBindings: AgentRouteBinding[] = [];
  for (const channel of [...channels].toSorted()) {
    for (const kind of ["direct", "group", "channel"] as const) {
      quarantineBindings.push({
        type: "route",
        agentId: COMMUNICATION_QUARANTINE_AGENT_ID,
        comment: `${MANAGED_BINDING_PREFIX}quarantine:${channel}:${kind}`,
        match: { channel, accountId: "*", peer: { kind, id: "*" } },
        session: { dmScope: "per-account-channel-peer" },
      });
    }
  }
  // Quarantine must precede pre-existing broad routes or an unknown peer could
  // reach the trusted default agent before the catch-all sees it.
  config.bindings = [...exactBindings, ...quarantineBindings, ...existingBindings];
  return config;
}
