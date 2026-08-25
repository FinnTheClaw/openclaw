// Browser tests cover vision plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT,
  describeBrowserScreenshot,
  neutralizeMediaDirectives,
} from "./vision.js";

type DescribeFn = ReturnType<typeof vi.fn>;

function makeDeps(
  describeCandidate: DescribeFn,
  overrides?: {
    normalizeBrowserScreenshot?: ReturnType<typeof vi.fn>;
    saveMediaBuffer?: ReturnType<typeof vi.fn>;
  },
) {
  return {
    describeImageFile: describeCandidate as never,
    normalizeBrowserScreenshot:
      (overrides?.normalizeBrowserScreenshot as never) ??
      (vi.fn(async (buffer: Buffer) => ({ buffer })) as never),
    saveMediaBuffer:
      (overrides?.saveMediaBuffer as never) ??
      (vi.fn(async () => ({ path: "/tmp/resized.jpg" })) as never),
  };
}

async function withTempImage<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-vision-"));
  const filePath = path.join(dir, "screenshot.png");
  await writeFile(filePath, Buffer.from("image"));
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("describeBrowserScreenshot", () => {
  it("uses existing image understanding config with a browser screenshot prompt", async () => {
    const describeEntry = vi.fn().mockResolvedValue({
      text: "A login screen.",
      provider: "openai",
      model: "gpt-vision",
      decision: { outcome: "success" },
    });

    await withTempImage(async (filePath) => {
      const result = await describeBrowserScreenshot(
        {
          cfg: {
            tools: {
              media: { image: { models: [{ provider: "openai", model: "gpt-vision" }] } },
            },
          },
          filePath,
          agentDir: "/tmp/agent",
          workspaceDir: "/tmp/workspace",
          activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
          mediaScope: { sessionKey: "agent:main:telegram:dm:123", channel: "telegram" },
        },
        makeDeps(describeEntry),
      );

      expect(result).toEqual({
        text: "A login screen.",
        provider: "openai",
        model: "gpt-vision",
        decision: { outcome: "success" },
      });
      expect(describeEntry).toHaveBeenCalledWith({
        filePath,
        cfg: {
          tools: {
            media: {
              image: {
                models: [{ provider: "openai", model: "gpt-vision" }],
              },
            },
          },
        },
        prompt: DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT,
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
        scopeContext: { sessionKey: "agent:main:telegram:dm:123", channel: "telegram" },
      });
    });
  });

  it.each([
    {
      name: "session-owned default agent without a directory",
      agentId: undefined,
      agentDir: undefined,
      sessionAgentId: "main",
    },
    {
      name: "explicit matching worker agent with an authoritative directory",
      agentId: "worker",
      agentDir: "/tmp/worker",
      sessionAgentId: "worker",
    },
  ])("passes the $name identity to image understanding", async (testCase) => {
    const describeEntry = vi.fn().mockResolvedValue({ text: "A dashboard." });

    await describeBrowserScreenshot(
      {
        cfg: {},
        filePath: "/tmp/screenshot.png",
        ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
        ...(testCase.agentDir ? { agentDir: testCase.agentDir } : {}),
        mediaScope: { sessionKey: `agent:${testCase.sessionAgentId}:webchat:direct:123` },
      },
      makeDeps(describeEntry),
    );

    expect(describeEntry).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: testCase.sessionAgentId, agentDir: testCase.agentDir }),
    );
  });

  it("rejects an agent identity that conflicts with its session before image understanding", async () => {
    const describeEntry = vi.fn().mockResolvedValue({ text: "A dashboard." });

    await expect(
      describeBrowserScreenshot(
        {
          cfg: {},
          filePath: "/tmp/screenshot.png",
          agentId: "worker",
          agentDir: "/tmp/worker",
          mediaScope: { sessionKey: "agent:main:webchat:direct:123" },
        },
        makeDeps(describeEntry),
      ),
    ).rejects.toThrow(/belongs to "main", not "worker"/);

    expect(describeEntry).not.toHaveBeenCalled();
  });

  it("resizes screenshots before image understanding when image sanitization is configured", async () => {
    const describeResult = vi.fn().mockResolvedValue({ text: "Small screenshot." });
    const normalizeBrowserScreenshot = vi.fn(async () => ({
      buffer: Buffer.from("small"),
      contentType: "image/jpeg" as const,
    }));
    const saveMediaBuffer = vi.fn(async () => ({ path: "/tmp/resized.jpg" }));

    await withTempImage(async (filePath) => {
      await describeBrowserScreenshot(
        {
          cfg: { browser: {} },
          filePath,
          imageSanitization: { maxDimensionPx: 800 },
        },
        makeDeps(describeResult, { normalizeBrowserScreenshot, saveMediaBuffer }),
      );
    });

    expect(normalizeBrowserScreenshot).toHaveBeenCalledWith(Buffer.from("image"), {
      maxSide: 800,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(Buffer.from("small"), "image/jpeg", "browser");
    expect(describeResult.mock.calls[0][0].filePath).toBe("/tmp/resized.jpg");
  });

  it("returns null when image understanding is skipped or not configured", async () => {
    const describeValue = vi.fn().mockResolvedValue({
      text: undefined,
      decision: { outcome: "skipped" },
    });

    await expect(
      describeBrowserScreenshot(
        { cfg: { browser: {} }, filePath: "/tmp/screenshot.png" },
        makeDeps(describeValue),
      ),
    ).resolves.toBeNull();
  });

  it("does not pass an incomplete active model to media understanding", async () => {
    const describeLocal = vi.fn().mockResolvedValue({ text: "ok" });

    await describeBrowserScreenshot(
      {
        cfg: {
          tools: {
            media: { image: { models: [{ provider: "openai", model: "gpt-vision" }] } },
          },
        },
        filePath: "/tmp/screenshot.png",
        activeModel: { model: "missing-provider" },
      },
      makeDeps(describeLocal),
    );

    expect(describeLocal.mock.calls[0][0].activeModel).toBeUndefined();
  });
});

describe("neutralizeMediaDirectives", () => {
  it("defangs line-start final-reply media directives", () => {
    expect(neutralizeMediaDirectives("ok\n  MEDIA:/tmp/secret.png\nMEDIA:http://x/y.png")).toBe(
      "ok\n  [neutralized] MEDIA:/tmp/secret.png\n[neutralized] MEDIA:http://x/y.png",
    );
  });

  it("leaves prose mentions alone", () => {
    expect(neutralizeMediaDirectives("see MEDIA: as plain prose")).toBe(
      "see MEDIA: as plain prose",
    );
  });
});
