import type { GatewayEventFrame } from "../../api/gateway.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { collectChatOutboxes, readVisibleChatOutbox } from "./chat-outbox-scopes.ts";
import type { ChatHost } from "./chat-send-contract.ts";

export async function resumeStoredChatOutboxes(host: ChatHost, event?: GatewayEventFrame) {
  if (!host.connected || !host.client || collectChatOutboxes(host, event).length === 0) {
    return;
  }
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const [{ resumeStoredChatOutboxes: resume }, { chatOutboxDrainDependencies }] = await Promise.all(
    [import("./chat-outbox-drain.ts"), import("./chat-send-delivery.runtime.ts")],
  );
  if (connectionIsCurrent()) {
    await resume(host, chatOutboxDrainDependencies, event);
  }
}

export async function flushChatQueueForEvent(host: ChatHost) {
  if (!readVisibleChatOutbox(host)) {
    return;
  }
  const connectionIsCurrent = captureChatConnectionOwner(host);
  const [{ flushStoredChatOutbox }, { chatOutboxDrainDependencies }] = await Promise.all([
    import("./chat-outbox-drain.ts"),
    import("./chat-send-delivery.runtime.ts"),
  ]);
  if (connectionIsCurrent()) {
    await flushStoredChatOutbox(host, chatOutboxDrainDependencies);
  }
}
