import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";
import { resetTelegramClientOptionsCacheForTests, withTelegramApiContext } from "./send-context.js";

const resolveTelegramTransport = vi.hoisted(() =>
  vi.fn<typeof import("./fetch.js").resolveTelegramTransport>(),
);

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
  resolveTelegramTransport,
}));

afterEach(() => {
  resetTelegramClientOptionsCacheForTests();
  resetTelegramAccountThrottlersForTest();
  resolveTelegramTransport.mockReset();
});

it("keeps an active send's transport alive through cache eviction", async () => {
  const arrived = createDeferred<void>();
  const release = createDeferred<void>();
  const close = vi.fn(async () => {});
  const unexpectedFetch = async () => {
    throw new Error("Unexpected fetch outside the held test send");
  };
  resolveTelegramTransport
    .mockReturnValue({
      fetch: unexpectedFetch,
      sourceFetch: unexpectedFetch,
      close: async () => {},
    })
    .mockReturnValueOnce({
      fetch: async () => {
        arrived.resolve();
        await release.promise;
        if (close.mock.calls.length > 0) {
          throw new Error("Transport closed while the send was pending");
        }
        return Response.json({ ok: true, result: { message_id: 17 } });
      },
      sourceFetch: unexpectedFetch,
      close,
    });

  const accounts = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [
      `acct-${index}`,
      { botToken: "1:fixture", apiRoot: "https://telegram.invalid" },
    ]),
  );
  const cfg = { channels: { telegram: { accounts } } };
  const sending = withTelegramApiContext({ cfg, accountId: "acct-0" }, ({ api }) =>
    api.sendMessage(123, "ordinary message"),
  );
  try {
    await Promise.race([
      arrived.promise,
      sending.then(() => {
        throw new Error("Send completed before reaching the fixture");
      }),
    ]);
    // Admissions alone fill the cache; no other Bot API calls are needed.
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        withTelegramApiContext({ cfg, accountId: `acct-${index + 1}` }, async () => {}),
      ),
    );
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await expect(sending).resolves.toMatchObject({ message_id: 17 });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await sending.catch(() => undefined);
  }
});
