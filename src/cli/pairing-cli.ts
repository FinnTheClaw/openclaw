import { createInterface } from "node:readline/promises";
// Pairing CLI for listing and approving channel DM pairing requests.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listPairingChannels, notifyPairingApproved } from "../channels/plugins/pairing.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  ensureCommunicationIdentityForPairing,
  listCommunicationIdentities,
  normalizeCommunicationPhone,
  reconcileCommunicationIdentityConfig,
  setCommunicationAdminPhone,
  type EnsuredCommunicationIdentity,
} from "../identity/communication-identities.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import { approveChannelPairingCode, listChannelPairingRequests } from "../pairing/pairing-store.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";

/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw: unknown, channels: PairingChannel[]): PairingChannel {
  const value = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(raw) ?? "");
  if (!value) {
    throw new Error(
      `Missing channel. Use ${formatCliCommand("openclaw pairing list --channel <channel>")}.`,
    );
  }

  const normalized = normalizeChannelId(value);
  if (normalized) {
    if (!channels.includes(normalized)) {
      throw new Error(
        `Channel "${normalized}" does not support pairing. Supported pairing channels: ${channels.join(", ") || "none"}.`,
      );
    }
    return normalized;
  }

  // Allow extension channels: validate format but don't require registry
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    return value as PairingChannel;
  }
  throw new Error(
    `Invalid channel "${value}". Use lowercase letters, numbers, "_" or "-", for example "telegram".`,
  );
}

async function notifyApproved(channel: PairingChannel, id: string, accountId?: string) {
  const cfg = getRuntimeConfig();
  await notifyPairingApproved({ channelId: channel, id, cfg, ...(accountId ? { accountId } : {}) });
}

function pairingIdentityPhone(params: {
  explicit?: unknown;
  meta?: Record<string, string>;
}): string | undefined {
  const candidates = [
    normalizeStringifiedOptionalString(params.explicit),
    params.meta?.e164,
    params.meta?.phone,
    params.meta?.phoneNumber,
    params.meta?.senderPhone,
    params.meta?.number,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCommunicationPhone(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

async function confirmAdminTransfer(phone: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Changing the communication admin requires an interactive host terminal.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Type ${phone} to transfer communication-admin authority to that phone: `,
    );
    if (answer.trim() !== phone) {
      throw new Error("Communication-admin transfer cancelled; confirmation did not match.");
    }
  } finally {
    prompt.close();
  }
}

export function registerPairingCli(program: Command) {
  const channels = listPairingChannels();
  // Avoid rendering a bare "()" enum when no channels are configured.
  const channelHint = channels.length > 0 ? channels.join(", ") : "none configured";
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pairing", "docs.openclaw.ai/cli/pairing")}\n`,
    );

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--channel <channel>", `Channel (${channelHint})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("[channel]", `Channel (${channelHint})`)
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg ?? (channels.length === 1 ? channels[0] : "");
      if (!channelRaw) {
        if (channels.length === 0) {
          // `pairing` is chat DM only; TUI/device approvals live under `openclaw devices`.
          throw new Error(
            `No chat DM pairing channels are configured. To approve a TUI or device request, ` +
              `use ${formatCliCommand("openclaw devices approve")} instead.`,
          );
        }
        throw new Error(`Channel required (expected one of: ${channelHint}).`);
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
      const requests = accountId
        ? await listChannelPairingRequests(channel, process.env, accountId)
        : await listChannelPairingRequests(channel);
      if (opts.json) {
        defaultRuntime.writeJson({ channel, requests });
        return;
      }
      if (requests.length === 0) {
        defaultRuntime.log(theme.muted(`No pending ${channel} pairing requests.`));
        return;
      }
      const idLabel = resolvePairingIdLabel(channel);
      const tableWidth = getTerminalTableWidth();
      defaultRuntime.log(
        `${theme.heading("Pairing requests")} ${theme.muted(`(${requests.length})`)}`,
      );
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Code", header: "Code", minWidth: 10 },
            { key: "ID", header: idLabel, minWidth: 12, flex: true },
            { key: "Meta", header: "Meta", minWidth: 8, flex: true },
            { key: "Requested", header: "Requested", minWidth: 12 },
          ],
          rows: requests.map((r) => ({
            Code: r.code,
            ID: r.id,
            Meta: r.meta ? JSON.stringify(r.meta) : "",
            Requested: r.createdAt,
          })),
        }).trimEnd(),
      );
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--channel <channel>", `Channel (${channelHint})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .option(
      "--identity-phone <e164>",
      "Canonical E.164 phone used to link this person across chat channels",
    )
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .action(async (codeOrChannel, code, opts) => {
      const defaultChannel = channels.length === 1 ? channels[0] : "";
      const usingExplicitChannel = Boolean(opts.channel);
      const hasPositionalCode = code != null;
      const channelRaw = usingExplicitChannel
        ? opts.channel
        : hasPositionalCode
          ? codeOrChannel
          : defaultChannel;
      const resolvedCode = usingExplicitChannel
        ? codeOrChannel
        : hasPositionalCode
          ? code
          : codeOrChannel;
      if (!channelRaw || !resolvedCode) {
        throw new Error(
          `Usage: ${formatCliCommand("openclaw pairing approve <channel> <code>")} (or: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")})`,
        );
      }
      if (opts.channel && code != null) {
        throw new Error(
          `Too many arguments. Use: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")}`,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
      let identity: EnsuredCommunicationIdentity | undefined;
      const beforeAllow = async (entry: { id: string; meta?: Record<string, string> }) => {
        const approvedAccountId =
          accountId || normalizeStringifiedOptionalString(entry.meta?.accountId);
        identity = await ensureCommunicationIdentityForPairing({
          channel,
          accountId: approvedAccountId,
          peerId: entry.id,
          identityPhone: pairingIdentityPhone({ explicit: opts.identityPhone, meta: entry.meta }),
        });
      };
      const approved = accountId
        ? await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
            accountId,
            beforeAllow,
          })
        : await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
            beforeAllow,
          });
      if (!approved) {
        throw new Error(
          `No pending pairing request found for code "${String(resolvedCode)}". Run ${formatCliCommand(`openclaw pairing list --channel ${channel}`)} to list pending requests.`,
        );
      }

      defaultRuntime.log(
        `${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.`,
      );
      if (!identity) {
        throw new Error("Pairing identity provisioning did not complete.");
      }
      defaultRuntime.log(
        identity.bootstrappedAdmin
          ? `${theme.success("Initial communication admin configured")} ${theme.command(identity.identity.id)}.`
          : `${theme.success("Isolated identity ready")} ${theme.command(identity.identity.id)} ${theme.muted(identity.isAdmin ? "(admin)" : "(sandboxed)")}.`,
      );

      if (!opts.notify) {
        return;
      }
      const approvedAccountId =
        accountId || normalizeStringifiedOptionalString(approved.entry?.meta?.accountId);
      await notifyApproved(channel, approved.id, approvedAccountId).catch((err: unknown) => {
        defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
      });
    });

  const identities = pairing
    .command("identities")
    .description("Inspect or reconcile isolated communication identities");

  identities
    .command("list")
    .description("List communication identities and their bound endpoints")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const state = await listCommunicationIdentities();
      if (opts.json) {
        defaultRuntime.writeJson(state);
        return;
      }
      if (state.identities.length === 0) {
        defaultRuntime.log(theme.muted("No communication identities are registered."));
        return;
      }
      defaultRuntime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "Role", header: "Role", minWidth: 9 },
            { key: "Identity", header: "Identity", minWidth: 16 },
            { key: "Phone", header: "Phone", minWidth: 12 },
            { key: "Endpoints", header: "Endpoints", minWidth: 20, flex: true },
          ],
          rows: state.identities.map((entry) => ({
            Role: entry.id === state.adminIdentityId ? "admin" : "sandboxed",
            Identity: entry.id,
            Phone: entry.phone ?? "-",
            Endpoints: entry.endpoints
              .map((endpoint) => `${endpoint.channel}/${endpoint.accountId}:${endpoint.peerId}`)
              .join(", "),
          })),
        }).trimEnd(),
      );
    });

  identities
    .command("reconcile")
    .description("Rebuild managed routes and isolation policy from the protected registry")
    .action(async () => {
      const registry = await reconcileCommunicationIdentityConfig();
      defaultRuntime.log(
        `${theme.success("Communication identities reconciled")} ${theme.muted(`(${Object.keys(registry.identities).length} identities).`)}`,
      );
    });

  const admin = pairing
    .command("admin")
    .description("Inspect or transfer communication-admin authority (host terminal only)");

  admin
    .command("show")
    .description("Show the current communication admin")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const state = await listCommunicationIdentities();
      const identity = state.adminIdentityId
        ? (state.identities.find((entry) => entry.id === state.adminIdentityId) ?? null)
        : null;
      if (opts.json) {
        defaultRuntime.writeJson({ adminIdentityId: state.adminIdentityId, identity });
        return;
      }
      if (!identity) {
        defaultRuntime.log(theme.warn("No communication admin is configured."));
        return;
      }
      defaultRuntime.log(
        `${theme.heading("Communication admin")} ${theme.command(identity.phone ?? identity.id)}`,
      );
    });

  admin
    .command("set")
    .description("Transfer admin authority to an E.164 phone from an interactive host terminal")
    .argument("<phone>", "New admin phone in E.164 format")
    .action(async (rawPhone) => {
      const phone = normalizeCommunicationPhone(String(rawPhone));
      if (!phone) {
        throw new Error("Admin phone must be a valid E.164 number, for example +15125550123.");
      }
      await confirmAdminTransfer(phone);
      const identity = await setCommunicationAdminPhone({ phone });
      defaultRuntime.log(
        `${theme.success("Communication admin transferred")} ${theme.command(phone)} ${theme.muted(`(${identity.id}).`)}`,
      );
    });
}
