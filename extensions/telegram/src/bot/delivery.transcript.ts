import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

export type DeliveryTranscriptMirror = (payload: {
  text?: string;
  mediaUrls?: string[];
}) => Promise<void> | void;

export type DeliveredTextObserver = (text: string) => Promise<void> | void;

export async function mirrorDeliveredReplies(
  transcriptMirror: DeliveryTranscriptMirror,
  deliveredContents: readonly { text: string; mediaUrls: string[] }[],
): Promise<void> {
  const text = deliveredContents
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n\n");
  const mediaUrls = deliveredContents.flatMap((content) => content.mediaUrls);
  if (text || mediaUrls.length > 0) {
    try {
      await transcriptMirror({
        text: text || undefined,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      });
    } catch (mirrorErr) {
      logVerbose(`telegram transcriptMirror failed: ${formatErrorMessage(mirrorErr)}`);
    }
  }
}

export async function observeDeliveredText(
  onDeliveredText: DeliveredTextObserver,
  parts: readonly { plainText: string }[],
): Promise<void> {
  const text = parts
    .map((part) => part.plainText)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  if (text) {
    try {
      await onDeliveredText(text);
    } catch (error) {
      logVerbose(`telegram delivered text observer failed: ${formatErrorMessage(error)}`);
    }
  }
}
