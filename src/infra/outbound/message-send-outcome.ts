/** Shared truth projection for outbound send and broadcast results. */
import type { MessageSendResult } from "./message.js";

export type MessageSendOutcome =
  | { ok: true }
  | { ok: false; error: string; sentBeforeError?: true };

export function resolveMessageSendOutcome(
  sendResult: MessageSendResult | undefined,
  action: "Message" | "Broadcast" = "Message",
): MessageSendOutcome {
  if (
    !sendResult ||
    sendResult.deliveryStatus === undefined ||
    sendResult.deliveryStatus === "sent"
  ) {
    return { ok: true };
  }
  switch (sendResult.deliveryStatus) {
    case "suppressed":
      return {
        ok: false,
        error: `${action} send suppressed: ${sendResult.suppressionReason ?? "unknown reason"}.`,
      };
    case "failed":
      return { ok: false, error: sendResult.error ?? `${action} send failed.` };
    case "partial_failed":
      return {
        ok: false,
        error: sendResult.error ?? `${action} send partially failed.`,
        sentBeforeError: true,
      };
  }
  return sendResult.deliveryStatus satisfies never;
}

export function isMessageSendSuccessful(
  sendResult: MessageSendResult | undefined,
  dryRun = false,
): boolean {
  return dryRun || resolveMessageSendOutcome(sendResult).ok;
}

export function areMessageBroadcastEntriesSuccessful(
  entries: ReadonlyArray<{ ok: boolean }>,
): boolean {
  return entries.every((entry) => entry.ok);
}
