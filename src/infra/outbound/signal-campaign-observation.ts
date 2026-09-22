/** Opt-in, owner-only Signal campaign observation. No transport simulation. */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/aiapi/.openclaw/campaigns/behavior-20260919-control/signal-v4";
const SOURCE = "3928bad9badfcb6c7d140530435e806fb8092190";
const KEY = "__finnSignalCampaignV1";
type Ticket = {
  source: string;
  token: string;
  slot: number;
  sessionKey: string;
  caseId: string;
  account: string;
  accountId: string;
  expiresAt: number;
  mode: string;
  upstreamBaseUrl?: string;
};
type Scope = { ticket: Ticket; runId: string };
type Native = {
  message: string;
  account?: string;
  accountId: string;
  recipient?: string;
  transport: string;
  quoted: boolean;
  media: boolean;
  baseUrl: string;
};
const shared = globalThis as unknown as { __finnSignalScopeV1?: AsyncLocalStorage<Scope> };
const scope = (shared.__finnSignalScopeV1 ??= new AsyncLocalStorage<Scope>());
export function isSignalCampaignSession(key: string | undefined): boolean {
  return /^agent:finn:campaign-signal-[0-9a-f]{32}$/.test(key ?? "");
}
function safeFile(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("Signal campaign private path rejected");
  }
  return stat;
}
function root(): string {
  if (process.env.OPENCLAW_SIGNAL_CAMPAIGN_ROOT !== ROOT) {
    throw new Error("Signal campaign not activated");
  }
  safeFile(ROOT);
  return ROOT;
}
function read(file: string): Ticket {
  const stat = safeFile(file);
  if (!stat.isFile() || stat.size > 16384) throw new Error("Signal campaign ticket bound");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Ticket;
}
function seal(file: string, value: unknown): void {
  safeFile(path.dirname(file));
  const temporary = file + ".stage-" + randomUUID();
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Atomic no-replace publication. A collision preserves the first writer.
    fs.linkSync(temporary, file);
  } finally {
    fs.unlinkSync(temporary);
  }
  const dir = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function event(s: Scope, kind: string, values: Record<string, unknown> = {}): void {
  seal(path.join(root(), "observations", s.ticket.token + "." + kind + ".json"), {
    token: s.ticket.token,
    sessionKey: s.ticket.sessionKey,
    caseId: s.ticket.caseId,
    runId: s.runId,
    at: Date.now() / 1000,
    ...values,
  });
}
export function prepareSignalCampaignDelivery(
  sessionKey: string | undefined,
  runId: string | undefined,
  channel: string | undefined,
  to: string | undefined,
  accountId: string | undefined,
  payloads: readonly { text?: string; mediaUrl?: string; mediaUrls?: string[] }[],
): Scope | undefined {
  if (!isSignalCampaignSession(sessionKey)) return undefined;
  const token = sessionKey!.slice("agent:finn:campaign-signal-".length);
  const t = read(path.join(root(), "tickets", token + ".json"));
  if (
    t.source !== SOURCE ||
    t.token !== token ||
    t.sessionKey !== sessionKey ||
    !Number.isInteger(t.slot) ||
    t.slot < 1 ||
    t.slot > 3 ||
    !runId ||
    !validMode(t) ||
    t.expiresAt <= Date.now() / 1000 ||
    t.expiresAt > Date.now() / 1000 + 600 ||
    channel !== "signal" ||
    to !== t.account ||
    accountId !== t.accountId ||
    !/^\+[1-9][0-9]{6,14}$/.test(t.account)
  ) {
    throw new Error("Signal campaign exact owned route rejected");
  }
  const s = { ticket: t, runId };
  const text = payloads[0]?.text ?? "";
  if (
    payloads.length !== 1 ||
    payloads.some((p) => p.mediaUrl || p.mediaUrls?.length) ||
    !text.startsWith("[FINN TEST " + t.caseId + "] ") ||
    text.length > 512 ||
    /[\r\n]/.test(text)
  ) {
    event(s, "blocked", { reason: "unlabeled_output" });
    throw new Error("Signal campaign unlabeled output blocked before send");
  }
  return s;
}
export function withSignalCampaignDelivery<T>(
  s: Scope | undefined,
  send: () => Promise<T>,
): Promise<T> {
  return s ? scope.run(s, send) : send();
}

function validMode(t: Ticket): boolean {
  return (
    (t.mode === "collector_disconnect_reconcile" && /^D4R-05[4-9][0-9]$/.test(t.caseId)) ||
    (t.mode === "accepted_transport_ambiguity" && /^D4R-0(48|49|5[0-3])[0-9]$/.test(t.caseId))
  );
}
function relayBaseUrl(t: Ticket, upstream: string): string | undefined {
  if (t.mode !== "accepted_transport_ambiguity") return undefined;
  if (t.upstreamBaseUrl !== upstream) throw new Error("Signal campaign upstream changed");
  const folder = path.join(root(), "relays", t.token);
  safeFile(path.dirname(folder));
  safeFile(folder);
  const value = read(path.join(folder, "READY.json")) as unknown as {
    token: string;
    baseUrl: string;
    upstreamBaseUrl: string;
    expiresAt: number;
  };
  const url = new URL(value.baseUrl);
  if (
    value.token !== t.token ||
    value.upstreamBaseUrl !== upstream ||
    value.expiresAt !== t.expiresAt ||
    value.expiresAt <= Date.now() / 1000 ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" + t.token
  ) {
    throw new Error("Signal campaign relay identity rejected");
  }
  return value.baseUrl;
}
function begin(n: Native) {
  const s = scope.getStore();
  if (!s) {
    // Recovery has no live owner scope. Reserved campaign labels cannot resend.
    if (/^\[FINN TEST D4R-0[45][0-9]{2}\]/.test(n.message)) {
      throw new Error("Signal campaign unowned/recovery send denied");
    }
    return undefined;
  }
  const t = s.ticket;
  if (
    n.account !== t.account ||
    n.recipient !== t.account ||
    n.accountId !== t.accountId ||
    n.transport !== "managed-native" ||
    n.quoted ||
    n.media ||
    !n.message.startsWith("[FINN TEST " + t.caseId + "] ") ||
    n.message.length > 512 ||
    /[\r\n]/.test(n.message) ||
    t.expiresAt <= Date.now() / 1000
  ) {
    throw new Error("Signal campaign native self route rejected");
  }
  const relay = relayBaseUrl(t, n.baseUrl);
  // Burn the physical ticket durably BEFORE dispatch. Never delete/refund.
  seal(path.join(root(), "budget", "slot-" + t.slot + ".started.json"), {
    token: t.token,
    sessionKey: t.sessionKey,
    runId: s.runId,
  });
  event(s, "started", { bodySha256: hash(n.message) });
  return {
    baseUrl: relay,
    timeoutMs: relay ? 20_000 : undefined,
    failed: () => event(s, "rpc-error", { outcome: "unknown" }),
    accepted: async (native: { timestamp?: number; messageId: string; receipt: unknown }) => {
      const holdUntil = Math.min(Date.now() / 1000 + 10, t.expiresAt);
      event(s, "accepted", {
        ...native,
        visibleText: n.message,
        bodySha256: hash(n.message),
        holdUntil,
        outcome:
          Number.isSafeInteger(native.timestamp) && native.timestamp! > 0
            ? "native_accepted"
            : "native_returned_no_identity",
      });
      if (t.mode === "accepted_transport_ambiguity") return;
      // Only the real callback is held. Transport already returned; never fake it.
      const release = path.join(root(), "observations", t.token + ".release.json");
      while (Date.now() / 1000 < holdUntil) {
        if (fs.existsSync(release)) {
          const value = read(release) as unknown as { token: string; runId: string };
          if (value.token !== t.token || value.runId !== s.runId) {
            throw new Error("Signal campaign release owner mismatch");
          }
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      // A missed collector is not a transport failure; preserve the native result.
      event(s, "barrier-timeout");
    },
  };
}
import { createHash, randomUUID } from "node:crypto";
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
// Shared in-process context survives core/plugin bundle boundaries; no network API.
(globalThis as unknown as Record<string, unknown>)[KEY] = { begin };
