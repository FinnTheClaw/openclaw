import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  apiResponses,
  chat,
  createBot,
  from,
  harness,
  nextTelegramTestMessageId,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { mediaDownload, telegramMediaPng } from "./bot.media.native.test-utils.js";
import { telegramPlugin } from "./channel.js";
import * as telegramSend from "./send.js";
import { cacheSticker, getCachedSticker } from "./sticker-cache.js";
import { resolveStickerVisionSupportRuntime } from "./sticker-vision.runtime.js";

vi.mock("./sticker-vision.runtime.js", { spy: true });
vi.mock("./send.js", { spy: true });

const base = { date: 1736380800, from, chat };

describe("registered Telegram stickers and local media", () => {
  it.each([false, true])(
    "scopes sendable sticker IDs to the observing bot (same bot alias: %s)",
    async (sameBot) => {
      vi.mocked(resolveStickerVisionSupportRuntime).mockResolvedValue(false);
      const tokenA = "111111:F33_FAKE_BOT_A";
      const tokenB = sameBot ? tokenA : "222222:F33_FAKE_BOT_B";
      const fileA = "F33_FAKE_FILE_A";
      const fileB = "F33_FAKE_FILE_B";
      const description = "F33 fixture fox waves hello";
      const fileUniqueId = `F33_FAKE_UNIQUE_${sameBot}`;
      const cfg = {
        channels: {
          telegram: {
            botToken: tokenA,
            dmPolicy: "open" as const,
            allowFrom: ["*"],
            streaming: { mode: "off" as const },
            actions: { sticker: true },
            accounts: {
              observer: { botToken: tokenB },
              alias: { botToken: tokenA },
            },
          },
        },
      };
      await cacheSticker({
        fileId: "F33_FAKE_LEGACY_FILE",
        fileUniqueId,
        description,
        cachedAt: "2026-01-20T10:00:00.000Z",
      });
      const botA = await createBot(false, true, cfg, false, "default");
      const botB = await createBot(false, true, cfg, false, "observer");
      const sticker = {
        file_unique_id: fileUniqueId,
        type: "regular" as const,
        width: 512,
        height: 512,
        is_animated: false,
        is_video: false,
        emoji: "🦊",
        set_name: "F33FixtureFoxes",
      };
      const firstMessageId = nextTelegramTestMessageId();
      await botA.handleUpdate({
        update_id: firstMessageId,
        message: {
          ...base,
          message_id: firstMessageId,
          sticker: { ...sticker, file_id: fileA },
        },
      });
      const beforeObservation = await telegramPlugin.actions!.handleAction!({
        channel: "telegram",
        action: "sticker-search",
        accountId: "observer",
        cfg,
        params: { query: description, limit: 5 },
        conversationReadOrigin: "direct-operator",
      });
      expect
        .soft(beforeObservation.details)
        .toMatchObject(
          sameBot
            ? { ok: true, count: 1, stickers: [{ fileId: fileA, description }] }
            : { ok: true, count: 0, stickers: [] },
        );

      const secondMessageId = nextTelegramTestMessageId();
      await botB.handleUpdate({
        update_id: secondMessageId,
        message: {
          ...base,
          message_id: secondMessageId,
          sticker: { ...sticker, file_id: fileB },
        },
      });
      expect.soft(harness.replySpy).toHaveBeenCalledTimes(2);
      for (const [context] of harness.replySpy.mock.calls) {
        expect.soft(context.BodyForAgent).toContain(description);
        expect.soft(context.SkipStickerMediaUnderstanding).toBe(true);
      }

      vi.mocked(telegramSend.sendStickerTelegram).mockClear();
      const sendCountBefore = apiCalls.mock.calls.filter(
        ([method]) => method === "sendSticker",
      ).length;
      const expected = [
        ["default", sameBot ? fileB : fileA, tokenA],
        ["observer", fileB, tokenB],
        ["alias", sameBot ? fileB : fileA, tokenA],
      ] as const;
      for (const [accountId, expectedFileId] of expected) {
        const result = await telegramPlugin.actions!.handleAction!({
          channel: "telegram",
          action: "sticker-search",
          accountId,
          cfg,
          params: { query: description, limit: 5 },
          conversationReadOrigin: "direct-operator",
        });
        expect.soft(result.details).toMatchObject({
          ok: true,
          count: 1,
          stickers: [{ fileId: expectedFileId, description }],
        });
        const details = result.details as { stickers: Array<{ fileId: string }> };
        expect.soft(details.stickers[0]?.fileId).toBe(expectedFileId);
        if (details.stickers[0]) {
          await telegramPlugin.actions!.handleAction!({
            channel: "telegram",
            action: "sticker",
            accountId,
            cfg,
            params: { to: String(chat.id), fileId: details.stickers[0].fileId },
            conversationReadOrigin: "direct-operator",
          });
        }
      }
      expect.soft(vi.mocked(telegramSend.sendStickerTelegram).mock.calls).toHaveLength(3);
      for (const [index, [, expectedFileId, token]] of expected.entries()) {
        expect
          .soft(vi.mocked(telegramSend.sendStickerTelegram).mock.calls[index])
          .toMatchObject([String(chat.id), expectedFileId, { token }]);
      }
      const sends = apiCalls.mock.calls
        .filter(([method]) => method === "sendSticker")
        .slice(sendCountBefore);
      expect.soft(sends).toHaveLength(3);
      expect
        .soft(sends.map(([, payload]) => (payload as { sticker: string }).sticker))
        .toEqual(expected.map(([, expectedFileId]) => expectedFileId));
    },
  );

  it("reuses a stored description, refreshes its file identity, and skips unsupported sticker bytes", async () => {
    vi.mocked(resolveStickerVisionSupportRuntime).mockResolvedValue(false);
    await cacheSticker({
      fileId: "old-file",
      fileUniqueId: "stable-sticker",
      emoji: "old",
      setName: "OldSet",
      description: "A waving sticker",
      cachedAt: "2026-01-20T10:00:00.000Z",
    });
    const bot = await createBot(false);
    const sticker = {
      file_id: "current-file",
      file_unique_id: "stable-sticker",
      type: "regular" as const,
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
      emoji: "new",
      set_name: "NewSet",
    };
    const stickerMessageId = nextTelegramTestMessageId();
    await bot.handleUpdate({
      update_id: stickerMessageId,
      message: { ...base, message_id: stickerMessageId, sticker },
    });
    expect(await getCachedSticker("stable-sticker")).toMatchObject({
      fileId: "current-file",
      emoji: "new",
      setName: "NewSet",
      description: "A waving sticker",
    });
    const context = harness.replySpy.mock.calls[0]![0];
    expect(context.BodyForAgent).toContain("A waving sticker");
    expect(context.SkipStickerMediaUnderstanding).toBe(true);
    expect(await readFile(context.media![0]!.path!)).toEqual(telegramMediaPng);
    for (const [index, variant] of [
      { is_animated: true, is_video: false },
      { is_animated: false, is_video: true },
    ].entries()) {
      const messageId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: messageId,
        message: {
          ...base,
          message_id: messageId,
          sticker: {
            ...sticker,
            ...variant,
            file_unique_id: `unsupported-${index}`,
            emoji: undefined,
          },
        },
      });
      const unavailable = harness.replySpy.mock.calls[index + 1]![0];
      expect(unavailable.BodyForAgent).toBe("<media:sticker>");
      expect(unavailable.media!.every((media) => media.path === undefined)).toBe(true);
    }
    expect(harness.replySpy).toHaveBeenCalledTimes(3);
    expect(mediaDownload).toHaveBeenCalledOnce();
    expect(apiCalls.mock.calls.filter(([method]) => method === "getFile")).toHaveLength(1);
  });

  it("reads a trusted Bot API host mount but refuses a readable file outside that root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-native-local-media-"));
    const outside = `${root}-outside.txt`;
    const token = "123456:local-media";
    try {
      await mkdir(path.join(root, token, "documents"), { recursive: true });
      await writeFile(path.join(root, token, "documents", "file.txt"), "trusted document bytes");
      await writeFile(outside, "must not enter the model");
      const bot = await createBot(false, true, {
        channels: {
          telegram: {
            botToken: token,
            dmPolicy: "open",
            allowFrom: ["*"],
            trustedLocalFileRoots: [root],
            streaming: { mode: "off" },
          },
        },
      });
      apiResponses.set("getFile", {
        ok: true,
        result: { file_path: `/var/lib/telegram-bot-api/${token}/documents/file.txt` },
      });
      const document = {
        file_id: "local-document",
        file_unique_id: "local-document-unique",
        file_name: "file.txt",
        mime_type: "text/plain",
      };
      const allowedId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: allowedId,
        message: { ...base, message_id: allowedId, document },
      });
      expect(await readFile(harness.replySpy.mock.calls[0]![0].media![0]!.path!, "utf8")).toBe(
        "trusted document bytes",
      );
      apiResponses.set("getFile", { ok: true, result: { file_path: outside } });
      const deniedId = nextTelegramTestMessageId();
      await bot.handleUpdate({
        update_id: deniedId,
        message: { ...base, message_id: deniedId, document },
      });
      expect(harness.replySpy.mock.calls[1]![0]).toMatchObject({
        BodyForAgent: "[media unavailable: download failed]",
        media: [{ kind: "document" }],
      });
      expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.path).toBeUndefined();
      expect(harness.replySpy.mock.calls[1]![0].media?.[0]?.url).toBeUndefined();
      expect(mediaDownload).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});
