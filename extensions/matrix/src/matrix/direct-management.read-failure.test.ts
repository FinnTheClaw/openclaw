// Matrix direct-account-data reads must not turn transport errors into destructive writes.
import { describe, expect, it, vi } from "vitest";
import {
  persistMatrixDirectRoomMapping,
  promoteMatrixDirectRoomCandidate,
  repairMatrixDirectRooms,
} from "./direct-management.js";
import type { MatrixClient } from "./sdk.js";
import { EventType } from "./send/types.js";

const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const ALICE_ROOM = "!alice:example.org";
const BOB_ROOM = "!bob:example.org";

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getAccountData: vi.fn(async () => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    getJoinedRoomMembers: vi.fn(async () => ["@bot:example.org", ALICE]),
    getRoomStateEvent: vi.fn(async () => ({})),
    setAccountData: vi.fn(async () => undefined),
    createDirectRoom: vi.fn(async () => ALICE_ROOM),
    ...overrides,
  } as unknown as MatrixClient;
}

function accountDataError(status: number, code: string): Error {
  return Object.assign(new Error(code), { httpStatus: status, errcode: code });
}

function persist(client: MatrixClient, roomId = ALICE_ROOM) {
  return persistMatrixDirectRoomMapping({ client, remoteUserId: ALICE, roomId });
}

describe("Matrix m.direct read failure preservation", () => {
  it("DM-B01 does not overwrite mappings after a transient 503 read failure", async () => {
    const cause = accountDataError(503, "M_UNKNOWN");
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw cause;
      }),
      setAccountData,
    });
    await expect(persist(client)).rejects.toBe(cause);
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B02 does not write after an account-data read timeout", async () => {
    const cause = new Error("read timed out");
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw cause;
      }),
      setAccountData,
    });
    await expect(persist(client)).rejects.toBe(cause);
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B03 reports repair-failed without overwriting on a 403 promotion read", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw accountDataError(403, "M_FORBIDDEN");
      }),
      setAccountData,
    });
    await expect(
      promoteMatrixDirectRoomCandidate({
        client,
        remoteUserId: ALICE,
        roomId: ALICE_ROOM,
      }),
    ).resolves.toEqual({
      classifyAsDirect: true,
      repaired: false,
      roomId: ALICE_ROOM,
      reason: "repair-failed",
    });
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B04 avoids room creation when repair cannot read m.direct", async () => {
    const cause = accountDataError(502, "M_UNKNOWN");
    const createDirectRoom = vi.fn(async () => ALICE_ROOM);
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw cause;
      }),
      createDirectRoom,
      setAccountData,
    });
    await expect(repairMatrixDirectRooms({ client, remoteUserId: ALICE })).rejects.toBe(cause);
    expect(createDirectRoom).not.toHaveBeenCalled();
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B05 creates a mapping when m.direct is authoritatively absent", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw accountDataError(404, "M_NOT_FOUND");
      }),
      setAccountData,
    });
    await expect(persist(client)).resolves.toBe(true);
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, { [ALICE]: [ALICE_ROOM] });
  });

  it("DM-B06 creates a mapping when the SDK returns undefined for absence", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({ setAccountData });
    await expect(persist(client)).resolves.toBe(true);
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, { [ALICE]: [ALICE_ROOM] });
  });

  it("DM-B07 does not treat a non-M_NOT_FOUND 404 as empty", async () => {
    const cause = accountDataError(404, "M_UNRECOGNIZED");
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw cause;
      }),
      setAccountData,
    });
    await expect(persist(client)).rejects.toBe(cause);
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B08 preserves another user's mapping while extending Alice's", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => ({
        [BOB]: [BOB_ROOM],
        [ALICE]: ["!older:example.org"],
      })),
      setAccountData,
    });
    await expect(persist(client)).resolves.toBe(true);
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      [BOB]: [BOB_ROOM],
      [ALICE]: [ALICE_ROOM, "!older:example.org"],
    });
  });

  it("DM-B09 leaves an already-mapped room unchanged without writing", async () => {
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({
      getAccountData: vi.fn(async () => ({ [BOB]: [BOB_ROOM], [ALICE]: [ALICE_ROOM] })),
      setAccountData,
    });
    await expect(persist(client)).resolves.toBe(false);
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("DM-B10 retries a failed queued read without losing an unrelated mapping", async () => {
    const cause = accountDataError(503, "M_UNKNOWN");
    const getAccountData = vi
      .fn()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue({ [BOB]: [BOB_ROOM] });
    const setAccountData = vi.fn(async () => undefined);
    const client = createClient({ getAccountData, setAccountData });
    const first = persist(client);
    const second = persist(client);
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes[0]).toEqual({ status: "rejected", reason: cause });
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: true });
    expect(setAccountData).toHaveBeenCalledTimes(1);
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      [BOB]: [BOB_ROOM],
      [ALICE]: [ALICE_ROOM],
    });
  });
});
