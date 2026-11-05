import fs from "node:fs/promises";
import path from "node:path";
import { isInboundPathAllowed } from "@openclaw/media-core/inbound-path-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { toInboundMediaFacts } from "../channels/inbound-event/media.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { renderInboundDocumentContext } from "./file-context.js";
import { resolveMediaAttachmentLocalRoots } from "./runner.attachments.js";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return { ...actual, readRemoteMediaBuffer: readRemoteMediaBufferMock };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("renderInboundDocumentContext", () => {
  it.each([
    { name: "disabled missing path", pathKind: "missing", allowUrl: false, expected: "none" },
    { name: "disabled blocked path", pathKind: "blocked", allowUrl: false, expected: "none" },
    { name: "allowed missing path", pathKind: "missing", allowUrl: true, expected: "remote" },
    { name: "allowed blocked path", pathKind: "blocked", allowUrl: true, expected: "remote" },
    { name: "disabled valid local path", pathKind: "valid", allowUrl: false, expected: "local" },
    { name: "disabled pure URL", pathKind: "url-only", allowUrl: false, expected: "none" },
  ] as const)("L11-F007 enforces URL policy at document fallback: $name", async (row) => {
    const root = await fs.realpath(tempDirs.make("openclaw-document-fallback-"));
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(stateDir, "sandboxes", "session-a");
    const siblingDir = path.join(stateDir, "sandboxes", "session-b");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    const localPath = path.join(workspaceDir, "local-note.txt");
    const blockedPath = path.join(siblingDir, "blocked-note.txt");
    const missingPath = path.join(workspaceDir, "missing-note.txt");
    const localText = "APPROVED-LOCAL-DOCUMENT";
    const blockedText = "BLOCKED-SIBLING-DOCUMENT";
    const remoteText = "SYNTHETIC-REMOTE-FALLBACK-DOCUMENT";
    await fs.writeFile(localPath, localText);
    await fs.writeFile(blockedPath, blockedText);
    const remoteUrl = "https://documents.example.invalid/synthetic-note.txt";
    const attachmentPath =
      row.pathKind === "valid"
        ? localPath
        : row.pathKind === "blocked"
          ? blockedPath
          : row.pathKind === "missing"
            ? missingPath
            : undefined;
    const ctx: MsgContext = {
      Body: "Synthetic document input",
      media: toInboundMediaFacts([
        {
          ...(attachmentPath ? { path: attachmentPath } : {}),
          url: remoteUrl,
          contentType: "text/plain",
          kind: "document",
        },
      ]),
    };
    const cfg: OpenClawConfig = {
      gateway: {
        http: {
          endpoints: {
            responses: { files: { allowUrl: row.allowUrl, maxBytes: 1024, timeoutMs: 1000 } },
          },
        },
      },
    };
    const ctxBefore = structuredClone(ctx);
    const cfgBefore = structuredClone(cfg);
    readRemoteMediaBufferMock.mockReset();
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: Buffer.from(remoteText, "utf8"),
      contentType: "text/plain",
      fileName: "synthetic-note.txt",
    });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      expect(ctx.media?.[0]?.url).toBe(remoteUrl);
      if (attachmentPath) {
        expect(ctx.media?.[0]?.path).toBe(attachmentPath);
      }
      const roots = resolveMediaAttachmentLocalRoots({ cfg, ctx, workspaceDir });
      expect(isInboundPathAllowed({ filePath: localPath, roots })).toBe(true);
      expect(isInboundPathAllowed({ filePath: blockedPath, roots })).toBe(false);
      if (row.pathKind === "blocked") {
        await expect(fs.readFile(blockedPath, "utf8")).resolves.toBe(blockedText);
      } else if (row.pathKind === "missing") {
        await expect(fs.stat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const context = await renderInboundDocumentContext({ ctx, cfg, workspaceDir });
      for (const [receipt] of readRemoteMediaBufferMock.mock.calls) {
        expect(receipt).toMatchObject({ url: remoteUrl, maxBytes: 1024, timeoutMs: 1000 });
      }
      if (row.expected === "remote") {
        expect(readRemoteMediaBufferMock).toHaveBeenCalledOnce();
        expect(context.text).toContain(remoteText);
        expect(context.text).not.toContain(localText);
      } else {
        expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
        expect(context.text).not.toContain(remoteText);
        if (row.expected === "local") {
          expect(context.text).toContain(localText);
        } else {
          expect(context.text).not.toContain(localText);
          expect(context.text).toContain(
            row.pathKind === "url-only"
              ? "[Attachment skipped: URL file sources are disabled]"
              : "[Attachment could not be read]",
          );
        }
      }
      if (row.pathKind === "url-only") {
        expect(context.text).toContain("[Attachment skipped: URL file sources are disabled]");
      }
      expect(context.text).not.toContain(blockedText);
      expect(context.images).toEqual([]);
      expect(ctx).toEqual(ctxBefore);
      expect(cfg).toEqual(cfgBefore);
    });
  });

  it.each([
    {
      text: "document body for the steered run",
      maxChars: undefined,
      expected: "document body for the steered run",
      truncated: false,
    },
    {
      text: "document body for the steered run",
      maxChars: 13,
      expected: "document body",
      truncated: true,
    },
    { text: "雪🙂", maxChars: 4, expected: "雪🙂", truncated: false },
    { text: "雪🙂!", maxChars: 4, expected: "雪🙂!", truncated: false },
    { text: "雪🙂!tail", maxChars: 4, expected: "雪🙂!", truncated: true },
    { text: "雪🙂tail", maxChars: 2, expected: "雪", truncated: true },
    { text: "not empty", maxChars: 0, expected: "", truncated: true },
  ])(
    "renders actual attachment text without mutating input at limit $maxChars for $text",
    async ({ text, maxChars, expected, truncated }) => {
      const workspaceDir = tempDirs.make("openclaw-document-context-");
      const mediaPath = path.join(workspaceDir, "steer-note.txt");
      await fs.writeFile(mediaPath, text);
      const ctx: MsgContext = {
        Body: "see attached",
        media: [{ path: mediaPath, contentType: "text/plain" }],
      };
      const original = structuredClone(ctx);

      const context = await renderInboundDocumentContext({ ctx, cfg: {}, workspaceDir, maxChars });

      expect(context.text).toContain('<file name="steer-note.txt" mime="text/plain">');
      expect(context.text).toContain(`\n---\n${expected}\n`);
      expect(context.text).not.toContain("[No extractable text]");
      expect(context.text).not.toContain("\uFFFD");
      if (!truncated) {
        expect(context.text).not.toContain("[Partial document:");
      } else {
        expect(context.text).toContain("[Partial document: text truncated.]");
        expect(context.text).not.toContain("for the steered run");
        expect(context.text.indexOf("[Partial document:")).toBeLessThan(
          context.text.indexOf("<<<EXTERNAL_UNTRUSTED_CONTENT"),
        );
      }
      expect(context.images).toEqual([]);
      // Rejected steering must leave the original input available for normal dispatch.
      expect(ctx).toEqual(original);
    },
  );
});
