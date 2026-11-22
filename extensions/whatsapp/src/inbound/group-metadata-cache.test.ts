import type { GroupMetadata, WASocket } from "baileys";
import { expect, it, vi } from "vitest";
import {
  createWhatsAppGroupMetadataCacheOwner,
  type WhatsAppGroupMetadataCache,
} from "./group-metadata-cache.js";

type GroupLookup = (jid: string) => Promise<GroupMetadata>;
type GroupHydration = () => Promise<Record<string, GroupMetadata>>;

function makeOwner(
  reconnectCache: WhatsAppGroupMetadataCache,
  groupMetadata: GroupLookup,
  groupFetchAllParticipating: GroupHydration,
) {
  return createWhatsAppGroupMetadataCacheOwner({
    sock: { groupMetadata, groupFetchAllParticipating } as WASocket,
    getCurrentSock: () => null,
    resolveInboundJid: async () => null,
    reconnectCache,
    listen: () => () => {},
    logVerbose: vi.fn(),
    logHydrationWarning: vi.fn(),
  });
}

const title = (id: string, subject: string): GroupMetadata => ({
  id,
  subject,
  owner: undefined,
  participants: [],
});

it("keeps a newer group title when startup hydration finishes late", async () => {
  const group = "123@g.us";
  const independent = "456@g.us";
  const reconnectCache: WhatsAppGroupMetadataCache = new Map();
  const hydration = Promise.withResolvers<Record<string, GroupMetadata>>();
  const fetchGroups = vi.fn<GroupHydration>(() => hydration.promise);
  const liveLookup = vi.fn<GroupLookup>().mockResolvedValue(title(group, "Current Group"));
  const first = makeOwner(reconnectCache, liveLookup, fetchGroups);
  first.start();
  try {
    await expect(first.get(group)).resolves.toMatchObject({ subject: "Current Group" });
    expect(fetchGroups).toHaveBeenCalledOnce();
    expect(liveLookup).toHaveBeenCalledExactlyOnceWith(group);
    expect(reconnectCache.get(group)?.subject).toBe("Current Group");

    hydration.resolve({
      [group]: title(group, "Former Group"),
      [independent]: title(independent, "Independent Group"),
    });
    await hydration.promise;
    expect(reconnectCache.get(independent)?.subject).toBe("Independent Group");
  } finally {
    hydration.resolve({});
    first.close();
  }

  const lookupUnavailable = vi.fn<GroupLookup>().mockRejectedValue(new Error("lookup unavailable"));
  const replacement = makeOwner(reconnectCache, lookupUnavailable, async () => ({}));
  replacement.start();
  try {
    await expect(replacement.get(independent)).resolves.toMatchObject({
      subject: "Independent Group",
    });
    const current = await replacement.get(group);
    expect(lookupUnavailable.mock.calls).toEqual([[independent], [group]]);
    expect(current.subject).toBe("Current Group");
  } finally {
    replacement.close();
  }
});
