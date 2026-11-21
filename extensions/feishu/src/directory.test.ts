import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuConfig } from "./types.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

// mock-isolation: directory lookups use synthetic SDK responses, not remote clients.
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));

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

function makeStaticCfg(overrides: Partial<FeishuConfig> = {}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: { "user:carla": {} },
        groups: { "chat-1": {} },
        groupAllowFrom: ["chat-2"],
        ...overrides,
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return makeStaticCfg({ appId: "cli_test_app_id", appSecret: "cli_test_app_secret" });
}

function page<T>(items: T[], pageToken?: string, hasMore = Boolean(pageToken)) {
  return { code: 0, data: { items, has_more: hasMore, page_token: pageToken } };
}

const users = (...ids: string[]) => ids.map((id) => ({ kind: "user", id }));
const groups = (...ids: string[]) => ids.map((id) => ({ kind: "group", id }));
const expiredToken = () => Promise.reject(new Error("token expired"));

function mockPeerList(list: ReturnType<typeof vi.fn>) {
  createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
}

function mockGroupList(list: ReturnType<typeof vi.fn>) {
  createFeishuClientMock.mockReturnValueOnce({ im: { chat: { list } } });
}

function livePeers(options: Omit<Parameters<typeof listFeishuDirectoryPeersLive>[0], "cfg"> = {}) {
  return listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), ...options });
}

describe("feishu directory (config-backed)", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it.each(
    feishuSecretRefPolicyCases.filter(
      (testCase) =>
        testCase.name === "provider allowlist excluding the selected credential" ||
        testCase.name === "configured env provider allowing the selected credential",
    ),
  )(
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

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = makeStaticCfg({
      allowFrom: [" feishu:user:ou_alice "],
      dms: { " lark:dm:ou_carla ": {} },
      groups: {},
      groupAllowFrom: [],
    });

    expect(await listFeishuDirectoryPeers({ cfg })).toEqual(users("ou_alice", "ou_carla"));
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    expect(await listFeishuDirectoryGroups({ cfg: makeStaticCfg() })).toEqual(
      groups("chat-1", "chat-2"),
    );
  });

  it("lists only read-authorized static peers and enabled groups", async () => {
    const cfg = makeStaticCfg({
      groups: { "chat-1": {}, "chat-disabled": { enabled: false } },
      groupAllowFrom: ["chat-2", "chat-disabled"],
    });

    await expect(listAuthorizedFeishuDirectoryPeers({ cfg })).resolves.toEqual(
      users("alice", "bob"),
    );
    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual(
      groups("chat-1", "chat-2"),
    );
  });

  it("applies the static group limit after authorization filtering", async () => {
    const cfg = makeStaticCfg({
      groupPolicy: "allowlist",
      groups: { "chat-blocked": { enabled: false }, "chat-allowed": {} },
      groupAllowFrom: [],
    });

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg, limit: 1 })).resolves.toEqual(
      groups("chat-allowed"),
    );
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    mockPeerList(vi.fn(expiredToken));
    await expect(livePeers({ query: "a" })).resolves.toEqual(users("alice", "carla"));
  });

  it.each([
    ["peer", 0],
    ["peer", -1],
    ["group", 0],
    ["group", -1],
  ] as const)("treats a nonpositive %s limit (%i) as unlimited", async (kind, limit) => {
    const items = ["first", "second"].map((suffix) =>
      kind === "peer" ? { open_id: `ou_${suffix}` } : { chat_id: `chat-${suffix}` },
    );
    const list = vi
      .fn()
      .mockResolvedValueOnce(page(items, "next/page+2="))
      .mockResolvedValueOnce(page(items));
    (kind === "peer" ? mockPeerList : mockGroupList)(list);
    const directory =
      kind === "peer" ? listFeishuDirectoryPeersLive : listFeishuDirectoryGroupsLive;

    const result = await directory({ cfg: makeConfiguredCfg(), limit, fallbackToStatic: false });
    expect(result.map((entry) => entry.id)).toEqual(
      kind === "peer"
        ? ["ou_first", "ou_second", "ou_first", "ou_second"]
        : ["chat-first", "chat-second", "chat-first", "chat-second"],
    );
    expect(list).toHaveBeenNthCalledWith(1, {
      params: { page_size: kind === "peer" ? 50 : 100, page_token: undefined },
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      params: { page_size: kind === "peer" ? 50 : 100, page_token: "next/page+2=" },
    });
  });

  it("paginates live groups until the filtered result limit is reached", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([{ chat_id: "chat-blocked", name: "Blocked" }], "page-2"))
      .mockResolvedValueOnce(page([{ chat_id: "chat-allowed", name: "Allowed" }]));
    mockGroupList(list);

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        limit: 1,
        filter: (group) => group.id !== "chat-blocked",
      }),
    ).resolves.toEqual([{ kind: "group", id: "chat-allowed", name: "Allowed" }]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: { page_size: 1, page_token: "page-2" },
    });
  });

  it("finds live peers matching the query on later pages before applying the limit", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([{ open_id: "ou_bob", name: "Bob" }], "next/page+2="))
      .mockResolvedValueOnce(
        page([
          { open_id: "ou_alice", name: "Mu\u0308ller" },
          { open_id: "ou_alice_2", name: "Mu\u0308ller Two" },
        ]),
      );
    mockPeerList(list);

    await expect(
      livePeers({ query: "MÜLLER", limit: 1, fallbackToStatic: false }),
    ).resolves.toEqual([{ kind: "user", id: "ou_alice", name: "Mu\u0308ller" }]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      params: { page_size: 50, page_token: "next/page+2=" },
    });
  });

  it.each([50, 51])("returns up to %i live peers across full provider pages", async (limit) => {
    let pageIndex = 0;
    const list = vi.fn(async () => {
      const start = pageIndex++ * 50;
      return page(
        Array.from({ length: 50 }, (_, offset) => ({ open_id: `ou_${start + offset}` })),
        "repeat",
      );
    });
    mockPeerList(list);

    await expect(livePeers({ limit, fallbackToStatic: false })).resolves.toEqual(
      Array.from({ length: limit }, (_, index) => ({ kind: "user", id: `ou_${index}` })),
    );
    expect(list).toHaveBeenCalledTimes(Math.ceil(limit / 50));
  });

  it("continues past empty peer pages and ignores entries without open IDs", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([], "empty-next"))
      .mockResolvedValueOnce(page([{ name: "Alice" }, { open_id: "ou_alice" }], "unused", false));
    mockPeerList(list);

    await expect(livePeers({ query: "alice" })).resolves.toEqual(users("ou_alice"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["peer", undefined],
    ["peer", ""],
    ["group", undefined],
    ["group", ""],
  ] as const)("rejects missing %s continuation tokens (%j)", async (kind, pageToken) => {
    const list = vi.fn().mockResolvedValue(page([], pageToken, true));
    (kind === "peer" ? mockPeerList : mockGroupList)(list);
    const directory =
      kind === "peer" ? listFeishuDirectoryPeersLive : listFeishuDirectoryGroupsLive;

    await expect(directory({ cfg: makeConfiguredCfg(), fallbackToStatic: false })).rejects.toThrow(
      `Feishu live ${kind} directory returned an empty page token`,
    );
    expect(list).toHaveBeenCalledOnce();
  });

  it.each([
    ["repeat", "repeat"],
    ["first", "second", "first"],
  ])("rejects cycling peer directory page tokens (%j)", async (...tokens) => {
    let index = 0;
    const list = vi.fn(async () => page([], tokens[index++], true));
    mockPeerList(list);

    await expect(livePeers({ fallbackToStatic: false })).rejects.toThrow(
      "Feishu live peer directory returned a repeated page token",
    );
    expect(list).toHaveBeenCalledTimes(tokens.length);
  });

  it.each([false, true])(
    "bounds peer pagination and permits a match on the final page (match: %s)",
    async (matchOnLastPage) => {
      let index = 0;
      const list = vi.fn(async () =>
        page(++index === 100 && matchOnLastPage ? [{ open_id: "ou_alice" }] : [], `page-${index}`),
      );
      mockPeerList(list);

      const result = livePeers({ query: "alice", limit: 1, fallbackToStatic: false });
      if (matchOnLastPage) {
        await expect(result).resolves.toEqual(users("ou_alice"));
      } else {
        await expect(result).rejects.toThrow(
          "Feishu live peer directory pagination limit exceeded",
        );
      }
      expect(list).toHaveBeenCalledTimes(100);
    },
  );

  it.each([undefined, false])(
    "applies the existing fallback policy after a later peer page fails (fallback: %s)",
    async (fallbackToStatic) => {
      const list = vi
        .fn()
        .mockResolvedValueOnce(page([{ open_id: "ou_bob" }], "next"))
        .mockResolvedValueOnce({ code: 40012, msg: "invalid page token" });
      mockPeerList(list);

      const result = livePeers({ limit: 2, fallbackToStatic });
      if (fallbackToStatic === false) {
        await expect(result).rejects.toThrow("invalid page token");
      } else {
        await expect(result).resolves.toEqual(users("alice", "bob"));
      }
      expect(list).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects repeated live group directory page tokens", async () => {
    const list = vi
      .fn()
      .mockResolvedValue(page([{ chat_id: "chat-blocked", name: "Blocked" }], "repeat"));
    mockGroupList(list);

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
    mockPeerList(vi.fn(expiredToken));

    await expect(livePeers({ fallbackToStatic: false })).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    mockGroupList(vi.fn(async () => ({ code: 999, msg: "forbidden" })));

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
