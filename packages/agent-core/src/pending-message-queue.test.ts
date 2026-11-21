import { expect, it } from "vitest";
import { PendingMessageQueue } from "./pending-message-queue.js";
import type { AgentMessage } from "./types.js";

const message = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

it("clearing invalidates an input already drained into an awaited checkpoint", () => {
  const queue = new PendingMessageQueue("all");
  const input = message("queued");
  queue.enqueue(input);
  expect(queue.drain()).toEqual([input]);
  queue.clear();
  expect(queue.consumeCancellation(input)).toBe(true);
  expect(queue.consumeCancellation(input)).toBe(false);
  expect(queue.peek()).toEqual([]);
});

it("clearing retains provider-admitted input until its ordinary commit", () => {
  const queue = new PendingMessageQueue("all");
  const input = message("admitted");
  queue.enqueue(input);
  const release = queue.reserve([input]);
  queue.drain();
  queue.clear();
  expect(queue.consumeCancellation(input)).toBe(false);
  expect(queue.peek()).toEqual([input]);
  queue.commit(input);
  release();
  expect(queue.peek()).toEqual([]);
});
