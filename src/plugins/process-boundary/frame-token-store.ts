export type PreparedFrame = Readonly<{ readonly __preparedFrame: unique symbol }>;

type Record<M> = {
  readonly metadata: M;
  packet: Buffer | null;
  readonly fence: bigint;
  state: "provisional" | "authorized" | "consumed" | "committed" | "fenced";
};

export type BoundFrameStore<M> = Readonly<{
  mint(metadata: M, packet: Buffer): PreparedFrame;
  inspect(
    token: unknown,
  ): Readonly<{ metadata: M; fence: bigint; state: Record<M>["state"] }> | undefined;
  take(
    token: unknown,
    expectedFence: bigint,
    authorize: (metadata: M) => boolean,
  ): Buffer | undefined;
  commit(token: unknown, expectedFence: bigint): boolean;
  fence(): bigint;
  currentFence(): bigint;
}>;

/** @internal A fresh store is bound to exactly one controller generation. */
export function createBoundFrameStore<M>(): BoundFrameStore<M> {
  const records = new WeakMap<object, Record<M>>();
  const live = new Set<object>();
  let fence = 1n;
  const recordFor = (token: unknown) =>
    typeof token === "object" && token !== null ? records.get(token) : undefined;

  return Object.freeze({
    mint(metadata: M, packet: Buffer): PreparedFrame {
      const token = Object.freeze({}) as PreparedFrame;
      records.set(token, { metadata, packet, fence, state: "provisional" });
      live.add(token);
      return token;
    },
    inspect(token: unknown) {
      const record = recordFor(token);
      return record
        ? Object.freeze({ metadata: record.metadata, fence: record.fence, state: record.state })
        : undefined;
    },
    take(token: unknown, expectedFence: bigint, authorize: (metadata: M) => boolean) {
      const record = recordFor(token);
      if (
        !record?.packet ||
        record.state !== "provisional" ||
        record.fence !== expectedFence ||
        fence !== expectedFence ||
        !authorize(record.metadata)
      ) {
        return undefined;
      }
      record.state = "authorized";
      if (fence !== expectedFence || record.fence !== expectedFence || !record.packet) {
        record.packet?.fill(0);
        record.packet = null;
        record.state = "fenced";
        live.delete(token as object);
        return undefined;
      }
      const packet = record.packet;
      record.state = "consumed";
      return packet;
    },
    commit(token: unknown, expectedFence: bigint): boolean {
      const record = recordFor(token);
      if (
        !record ||
        record.state !== "consumed" ||
        record.fence !== expectedFence ||
        fence !== expectedFence
      ) {
        return false;
      }
      record.packet?.fill(0);
      record.packet = null;
      record.state = "committed";
      live.delete(token as object);
      return true;
    },
    fence(): bigint {
      fence += 1n;
      for (const token of live) {
        const record = records.get(token);
        if (record && record.state !== "committed" && record.state !== "fenced") {
          record.packet?.fill(0);
          record.packet = null;
          record.state = "fenced";
        }
      }
      live.clear();
      return fence;
    },
    currentFence: () => fence,
  });
}
