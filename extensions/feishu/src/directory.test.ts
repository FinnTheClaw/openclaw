// Feishu tests cover directory plugin behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const { listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive } = await importFreshModule<
  typeof import("./directory.js")
>(import.meta.url, "./directory.js?directory-test");
const { listFeishuDirectoryGroups, listFeishuDirectoryPeers } = await importFreshModule<
  typeof import("./directory.static.js")
>(import.meta.url, "./directory.static.js?directory-test");
const { listAuthorizedFeishuDirectoryGroups, listAuthorizedFeishuDirectoryPeers } =
  await importFreshModule<typeof import("./directory.static.js")>(
    import.meta.url,
    "./directory.static.js?authorized-directory-test",
  );

function makeStaticCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: {
          "user:carla": {},
        },
        groups: {
          "chat-1": {},
        },
        groupAllowFrom: ["chat-2"],
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        ...makeStaticCfg().channels?.feishu,
        appId: "cli_test_app_id",
        appSecret: "cli_test_app_secret",
      },
    },
  } as ClawdbotConfig;
}

describe("feishu directory (config-backed)", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it.each(feishuSecretRefPolicyCases)(
    "permits live directory requests only under configured SecretRef policy: $name",
    async (testCase) => {
      vi.stubEnv(FEISHU_SELECTED_SECRET_ENV, "selected-secret");
      vi.stubEnv(FEISHU_SIBLING_SECRET_ENV, "sibling-secret");
      const listPeers = vi.fn(async () => ({ code: 0, data: { items: [] } }));
      const listGroups = vi.fn(async () => ({ code: 0, data: { items: [] } }));
      createFeishuClientMock.mockReturnValue({
        contact: { user: { list: listPeers } },
        im: { chat: { list: listGroups } },
      });
      const cfg = createFeishuSecretRefPolicyConfig(testCase);

      try {
        await expect(listFeishuDirectoryPeersLive({ cfg, accountId: "selected" })).resolves.toEqual(
          [],
        );
        await expect(
          listFeishuDirectoryGroupsLive({ cfg, accountId: "selected" }),
        ).resolves.toEqual([]);

        if (!testCase.configured) {
          expect(createFeishuClientMock).not.toHaveBeenCalled();
          expect(listPeers).not.toHaveBeenCalled();
          expect(listGroups).not.toHaveBeenCalled();
          return;
        }

        expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
        expect(createFeishuClientMock).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "selected",
            appId: "selected-app",
            appSecret: "selected-secret", // pragma: allowlist secret
            configured: true,
          }),
        );
        expect(listPeers).toHaveBeenCalledOnce();
        expect(listGroups).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("merges allowFrom + dms into peer entries", async () => {
    const peers = await listFeishuDirectoryPeers({ cfg: makeStaticCfg(), query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = {
      channels: {
        feishu: {
          allowFrom: [" feishu:user:ou_alice "],
          dms: {
            " lark:dm:ou_carla ": {},
          },
          groups: {},
          groupAllowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const peers = await listFeishuDirectoryPeers({ cfg });
    expect(peers).toEqual([
      { kind: "user", id: "ou_alice" },
      { kind: "user", id: "ou_carla" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const groups = await listFeishuDirectoryGroups({ cfg: makeStaticCfg() });
    expect(groups).toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("lists only read-authorized static peers and enabled groups", async () => {
    const cfg = makeStaticCfg();
    const feishu = cfg.channels?.feishu;
    if (!feishu) {
      throw new Error("Expected Feishu config");
    }
    feishu.groups = {
      ...feishu.groups,
      "chat-disabled": { enabled: false },
    };

    await expect(listAuthorizedFeishuDirectoryPeers({ cfg })).resolves.toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
    ]);
    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("keeps explicitly disabled groups out even when groupAllowFrom includes them", async () => {
    const cfg = makeStaticCfg();
    const feishu = cfg.channels?.feishu;
    if (!feishu) {
      throw new Error("Expected Feishu config");
    }
    feishu.groups = {
      ...feishu.groups,
      "chat-disabled": { enabled: false },
    };
    feishu.groupAllowFrom = [...(feishu.groupAllowFrom ?? []), "chat-disabled"];

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("applies the static group limit after authorization filtering", async () => {
    const cfg = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          groups: {
            "chat-blocked": { enabled: false },
            "chat-allowed": {},
          },
        },
      },
    } as ClawdbotConfig;

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg, limit: 1 })).resolves.toEqual([
      { kind: "group", id: "chat-allowed" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    const peers = await listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("paginates live groups until the filtered result limit is reached", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-blocked", name: "Blocked" }],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-allowed", name: "Allowed" }],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        limit: 1,
        filter: (group) => group.id !== "chat-blocked",
      }),
    ).resolves.toEqual([{ kind: "group", id: "chat-allowed", name: "Allowed" }]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        page_size: 1,
        page_token: "page-2",
      },
    });
  });

  it("rejects repeated live group directory page tokens", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{ chat_id: "chat-blocked", name: "Blocked" }],
        has_more: true,
        page_token: "repeat",
      },
    });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        filter: () => false,
        fallbackToStatic: false,
      }),
    ).rejects.toThrow("Feishu live group directory returned a repeated page token");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("surfaces live peer lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          list: vi.fn(async () => ({ code: 999, msg: "forbidden" })),
        },
      },
    });

    await expect(
      listFeishuDirectoryGroupsLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("forbidden");
  });

  describe("round-seven live peer pagination", () => {
    const users = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        open_id: `ou_${start + index}`,
        name: `User ${start + index}`,
      }));
    const positiveCases = [
      {
        name: "feishu_peer_single_page_control",
        pages: [{ items: users(0, 2), has_more: false }],
        ids: ["ou_0", "ou_1"],
        calls: 1,
        limit: 2,
      },
      {
        name: "feishu_peer_51st_user",
        pages: [
          { items: users(0, 50), has_more: true, page_token: "page-2" },
          { items: users(50, 1), has_more: false },
        ],
        ids: users(0, 51).map((user) => user.open_id),
        calls: 2,
        limit: 51,
      },
      {
        name: "feishu_peer_120_users",
        pages: [
          { items: users(0, 50), has_more: true, page_token: "page-2" },
          { items: users(50, 50), has_more: true, page_token: "page-3" },
          { items: users(100, 20), has_more: false },
        ],
        ids: users(0, 120).map((user) => user.open_id),
        calls: 3,
        limit: 120,
      },
      {
        name: "feishu_peer_filtered_first_page_empty",
        pages: [
          { items: [{ open_id: "ou_other", name: "Other" }], has_more: true, page_token: "page-2" },
          { items: [{ open_id: "ou_target", name: "Target" }], has_more: false },
        ],
        ids: ["ou_target"],
        calls: 2,
        limit: 1,
        query: "target",
      },
      {
        name: "feishu_peer_limit_stops_before_third_page",
        pages: [
          { items: users(0, 2), has_more: true, page_token: "page-2" },
          { items: users(2, 1), has_more: false },
        ],
        ids: ["ou_0", "ou_1"],
        calls: 1,
        limit: 2,
      },
      {
        name: "feishu_peer_missing_open_id_then_next_page",
        pages: [
          { items: [{ name: "Missing ID" }], has_more: true, page_token: "page-2" },
          { items: [{ open_id: "ou_valid", name: "Valid" }], has_more: false },
        ],
        ids: ["ou_valid"],
        calls: 2,
        limit: 1,
      },
    ] as const;

    it.each(positiveCases)("$name", async (testCase) => {
      let page = 0;
      const list = vi.fn(async () => ({ code: 0, data: testCase.pages[page++] }));
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
      const peers = await listFeishuDirectoryPeersLive({
        cfg: makeConfiguredCfg(),
        limit: testCase.limit,
        query: "query" in testCase ? testCase.query : undefined,
        fallbackToStatic: false,
      });
      expect(peers.map((peer) => peer.id)).toEqual(testCase.ids);
      expect(list).toHaveBeenCalledTimes(testCase.calls);
      if (testCase.calls > 1) {
        expect(list).toHaveBeenNthCalledWith(2, {
          params: { page_size: Math.min(testCase.limit, 50), page_token: "page-2" },
        });
      }
    });

    it("feishu_peer_second_page_error_strict", async () => {
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          code: 0,
          data: { items: [], has_more: true, page_token: "page-2" },
        })
        .mockResolvedValueOnce({ code: 403, msg: "forbidden" });
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
      await expect(
        listFeishuDirectoryPeersLive({
          cfg: makeConfiguredCfg(),
          limit: 2,
          fallbackToStatic: false,
        }),
      ).rejects.toThrow("forbidden");
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("feishu_peer_second_page_exception_default_fallback", async () => {
      const list = vi
        .fn()
        .mockResolvedValueOnce({
          code: 0,
          data: { items: [], has_more: true, page_token: "page-2" },
        })
        .mockRejectedValueOnce(new Error("transport failed"));
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
      const peers = await listFeishuDirectoryPeersLive({
        cfg: makeConfiguredCfg(),
        query: "a",
        limit: 2,
      });
      expect(peers.map((peer) => peer.id)).toEqual(["alice", "carla"]);
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("feishu_peer_repeated_token", async () => {
      const list = vi.fn(async () => ({
        code: 0,
        data: { items: [], has_more: true, page_token: "repeat" },
      }));
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
      await expect(
        listFeishuDirectoryPeersLive({
          cfg: makeConfiguredCfg(),
          fallbackToStatic: false,
        }),
      ).rejects.toThrow("Feishu live peer directory returned a repeated page token");
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("feishu_peer_page_cap", async () => {
      let page = 0;
      const list = vi.fn(async () => ({
        code: 0,
        data: { items: [], has_more: true, page_token: `page-${++page}` },
      }));
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
      await expect(
        listFeishuDirectoryPeersLive({
          cfg: makeConfiguredCfg(),
          fallbackToStatic: false,
        }),
      ).rejects.toThrow("Feishu live peer directory pagination limit exceeded");
      expect(list).toHaveBeenCalledTimes(100);
    });
  });
});
