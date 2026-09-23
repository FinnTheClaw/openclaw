import { describe, expect, it, vi } from "vitest";
import { waitForSlackNoReply } from "./slack-live.message-observations.js";

const marker = "SLACK_QA_NOMENTION_MARKER";
const sut = { ts: "2.000000", user: "U-SUT", text: marker };

function makeClient(history: () => unknown[], replies: () => unknown[]) {
  return {
    conversations: {
      history: vi.fn(async () => ({ messages: history() })),
      replies: vi.fn(async (_params: unknown) => ({ messages: replies() })),
    },
  };
}

async function observe(params: {
  client: ReturnType<typeof makeClient>;
  observedMessages?: Array<unknown>;
  sentTs?: string;
  threadTs?: string;
  timeoutMs?: number;
}) {
  const observedMessages = params.observedMessages ?? [];
  await waitForSlackNoReply({
    channelId: "C123",
    client: params.client as never,
    matchText: marker,
    observedMessages: observedMessages as never,
    observationScenarioId: "slack-mention-gating",
    observationScenarioTitle: "No reply",
    sentTs: params.sentTs ?? "1.000000",
    sutIdentity: { userId: "U-SUT" },
    threadTs: params.threadTs,
    timeoutMs: params.timeoutMs ?? 30,
  });
  return observedMessages;
}

describe("Slack no-reply observation across channel and thread", () => {
  it("SL1 root-channel matching SUT reply fails", async () => {
    await expect(
      observe({
        client: makeClient(
          () => [sut],
          () => [],
        ),
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
  });

  it("SL2 thread-only matching SUT reply fails", async () => {
    await expect(
      observe({
        client: makeClient(
          () => [],
          () => [sut],
        ),
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
  });

  it("SL3 no reply in either surface passes", async () => {
    const client = makeClient(
      () => [],
      () => [],
    );
    await expect(observe({ client })).resolves.toEqual([]);
    expect(client.conversations.history).toHaveBeenCalled();
    expect(client.conversations.replies).toHaveBeenCalled();
  });

  it("SL4 unrelated SUT text is observed but passes", async () => {
    const observed = await observe({
      client: makeClient(
        () => [{ ...sut, text: "unrelated" }],
        () => [],
      ),
    });
    expect(observed).toMatchObject([{ text: "unrelated", matchedScenario: false }]);
  });

  it("SL5 matching non-SUT reply passes", async () => {
    const observed = await observe({
      client: makeClient(
        () => [],
        () => [{ ...sut, user: "U-OTHER" }],
      ),
    });
    expect(observed).toEqual([]);
  });

  it("SL6 sent message itself is ignored in both surfaces", async () => {
    const sent = { ...sut, ts: "1.000000" };
    const observed = await observe({
      client: makeClient(
        () => [sent],
        () => [sent],
      ),
    });
    expect(observed).toEqual([]);
  });

  it("SL7 duplicate channel and thread message is recorded once", async () => {
    const observed = await observe({
      client: makeClient(
        () => [{ ...sut, text: "unrelated" }],
        () => [{ ...sut, text: "unrelated" }],
      ),
    });
    expect(observed).toHaveLength(1);
  });

  it("SL8 preexisting input thread queries the parent thread timestamp", async () => {
    const client = makeClient(
      () => [],
      () => [],
    );
    await observe({ client, threadTs: "0.000000" });
    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", ts: "0.000000" }),
    );
  });

  it("SL9 replies API failure fails with contextual error", async () => {
    const client = makeClient(
      () => [],
      () => [],
    );
    client.conversations.replies.mockRejectedValueOnce(new Error("replies unavailable"));
    await expect(observe({ client })).rejects.toThrow(
      "Slack conversations.replies failed while checking no reply for slack-mention-gating",
    );
  });

  it("SL10 delayed thread SUT reply during observation fails", async () => {
    let polls = 0;
    const client = makeClient(
      () => [],
      () => (++polls >= 2 ? [sut] : []),
    );
    await expect(observe({ client, timeoutMs: 1_200 })).rejects.toThrow(
      "unexpected Slack SUT reply observed",
    );
    expect(client.conversations.replies).toHaveBeenCalledTimes(2);
  });
});
