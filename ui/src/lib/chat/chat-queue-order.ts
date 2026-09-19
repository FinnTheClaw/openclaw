import type { ChatQueueItem } from "./chat-types.ts";

type ChatQueuePosition = Pick<ChatQueueItem, "createdAt" | "orderKey">;

/**
 * Canonical queue position. `orderKey` is the operator-owned position; `createdAt`
 * is the arrival fact and stays the default so an untouched queue is FIFO.
 */
export function chatQueueOrderKey(item: ChatQueuePosition): number {
  return item.orderKey ?? item.createdAt;
}

/**
 * The one queue comparator. Display projection, drain head selection, and
 * alias merge all sort through it, so what the operator sees is
 * what the Gateway receives. Equal positions keep their existing relative order
 * through sort stability, which is how same-millisecond arrivals stayed FIFO.
 */
export function compareChatQueueOrder(left: ChatQueuePosition, right: ChatQueuePosition): number {
  return chatQueueOrderKey(left) - chatQueueOrderKey(right);
}

/**
 * A row may move while it is still waiting for its turn. Rows already attached
 * to a run — sending, running a command, or awaiting settings — keep
 * their place, so a move can never jump ahead of work already handed over.
 */
export function isMovableChatQueueItem(item: ChatQueueItem): boolean {
  return (
    !item.pendingRunId &&
    !item.intent &&
    (item.sendState === undefined ||
      item.sendState === "waiting-idle" ||
      item.sendState === "waiting-reconnect" ||
      item.sendState === "failed")
  );
}

/**
 * The queue split into contiguous runs of movable rows. A locked row is a
 * delivery barrier the drain stops on, so it ends the run either side of it and
 * a move may never cross it: permuting positions across a barrier would let a
 * later message reach the Gateway ahead of work whose delivery is still open.
 * Callers pass their own predicate when they hold a row for another reason.
 */
export function chatQueueMovableSegments(
  queue: readonly ChatQueueItem[],
  isMovable: (item: ChatQueueItem) => boolean = isMovableChatQueueItem,
): ChatQueueItem[][] {
  const segments: ChatQueueItem[][] = [];
  let run: ChatQueueItem[] = [];
  for (const item of queue.toSorted(compareChatQueueOrder)) {
    if (isMovable(item)) {
      run.push(item);
      continue;
    }
    if (run.length > 0) {
      segments.push(run);
      run = [];
    }
  }
  if (run.length > 0) {
    segments.push(run);
  }
  return segments;
}

/**
 * Moves one row to `toIndex` and returns the complete ordered segment.
 * Equal key slots retain this physical order; never mint positions that could
 * cross an unchanged delivery barrier outside the segment.
 * Positions are permuted among the rows instead of minted fresh, so a later
 * arrival — which carries a current `createdAt` — still sorts behind the queue.
 */
export function reorderChatQueueItems(
  queue: readonly ChatQueueItem[],
  id: string,
  toIndex: number,
): ChatQueueItem[] {
  const ordered = queue.toSorted(compareChatQueueOrder);
  const from = ordered.findIndex((item) => item.id === id);
  const to = Math.min(Math.max(toIndex, 0), ordered.length - 1);
  if (from < 0 || from === to) {
    return [];
  }
  const keys = ordered.map(chatQueueOrderKey);
  const moved = ordered.splice(from, 1)[0]!;
  ordered.splice(to, 0, moved);
  // oxlint-disable-next-line oxc/no-map-spread -- copy-on-write preserves caller-owned queue rows and delivery CAS snapshots
  return ordered.map((item, index) =>
    chatQueueOrderKey(item) === keys[index] ? item : { ...item, orderKey: keys[index]! },
  );
}
