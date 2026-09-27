import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FRAME_BODY_CAP,
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  MAX_DEADLINE_AHEAD_NS,
  REGISTER_BODY_CAP,
  UINT64_MAX,
  createGenerationCodec,
  encodeWorkerFrame,
} from "./frame-codec.js";
import { channelId, key } from "./frame-codec.test-helpers.js";
import {
  active,
  inboundPacket,
  loading,
  peerContext,
  requestHex,
} from "./session-fsm.test-helpers.js";

function retag(controller: ReturnType<typeof loading>, packet: Buffer): void {
  createHmac("sha256", peerContext(controller).key)
    .update(packet.subarray(0, 96))
    .update(packet.subarray(FRAME_HEADER_BYTES))
    .digest()
    .copy(packet, 96);
}
function faultFor(packet: Uint8Array): string | undefined {
  return loading().admitInbound(packet, "hostile", 1n).snapshot.fault;
}

describe("C07 hostile authenticated frame handling", () => {
  it("fences a reentrant key delivery before a second callback", () => {
    const codec = createGenerationCodec({ bootEpoch: Buffer.alloc(16, 1), generation: 1n });
    let calls = 0;
    let alias!: Buffer;
    expect(() =>
      codec.deliverKeyInstall((packet) => {
        calls += 1;
        alias = packet;
        expect(() => codec.deliverKeyInstall(() => true)).toThrow("key-install-state");
        return true;
      }),
    ).toThrow("key-install-rejected");
    expect(calls).toBe(1);
    expect(alias).toEqual(Buffer.alloc(alias.length));
    expect(() => codec.deliverKeyInstall(() => true)).toThrow("key-install-state");
  });

  it("zeroizes rejected delivery and fences successful authority on repeat", () => {
    const rejected = createGenerationCodec({ bootEpoch: Buffer.alloc(16, 1), generation: 1n });
    let rejectedAlias!: Buffer;
    expect(() =>
      rejected.deliverKeyInstall((packet) => {
        rejectedAlias = packet;
        return false;
      }),
    ).toThrow("key-install-rejected");
    expect(rejectedAlias).toEqual(Buffer.alloc(rejectedAlias.length));
    expect(() => rejected.deliverKeyInstall(() => true)).toThrow("key-install-state");

    const repeated = createGenerationCodec({ bootEpoch: Buffer.alloc(16, 2), generation: 2n });
    repeated.deliverKeyInstall(() => true);
    const prepared = repeated.prepare({ kind: FRAME_KIND.DRAIN }, 1n, 1n, 1n, 1n);
    let calls = 0;
    expect(() =>
      repeated.deliverKeyInstall(() => {
        calls += 1;
        return true;
      }),
    ).toThrow("key-install-state");
    expect(calls).toBe(0);
    expect(repeated.take(prepared.token, 1n, () => true)).toBeUndefined();
  });

  it("maps hostile pre-decode exceptions to a bounded fault", () => {
    const hostile = Object.defineProperty({}, "byteLength", {
      get() {
        throw new Error("secret-packet-identity");
      },
    }) as Uint8Array;
    const result = loading().admitInbound(hostile, "hostile", 1n);
    expect(result.snapshot.fault).toBe("frame-decode");
    expect(JSON.stringify(result.snapshot)).not.toContain("secret-packet-identity");
  });

  it("rejects short, over-cap, and mismatched exact packet lengths", () => {
    const controller = loading();
    const value = inboundPacket({ controller, kind: FRAME_KIND.REGISTER, body: Buffer.from([1]) });
    expect(controller.admitInbound(value.subarray(0, 127), "short", 1n).snapshot.fault).toBe(
      "truncated-header",
    );
    expect(faultFor(value.subarray(0, 128))).toBe("packet-length");
    expect(faultFor(Buffer.concat([value, Buffer.from([0])]))).toBe("packet-length");
    expect(faultFor(Buffer.alloc(FRAME_HEADER_BYTES + FRAME_BODY_CAP + 1))).toBe("packet-cap");
  });

  it("checks MAC before authenticated semantic fields", () => {
    const controller = loading();
    const packet = inboundPacket({ controller, kind: FRAME_KIND.REGISTER });
    packet[7] = 1;
    packet[100] ^= 1;
    expect(controller.admitInbound(packet, "bad", 1n).snapshot.fault).toBe("mac");
  });

  it.each([
    [0, 0x00, "magic"],
    [4, 0x01, "version"],
    [6, 0x06, "kind"],
    [7, 0x01, "reserved"],
    [8, 0x01, "reserved"],
    [88, 0x01, "reserved"],
  ])("rejects frozen-header mutation at byte %i", (offset, value, code) => {
    const controller = loading();
    const packet = inboundPacket({ controller, kind: FRAME_KIND.REGISTER });
    packet[offset] = value;
    if (offset >= 6) {
      retag(controller, packet);
    }
    expect(controller.admitInbound(packet, "bad", 1n).snapshot.fault).toBe(code);
  });

  it("binds channel, boot epoch, generation, and sequence", () => {
    const channelOwner = loading();
    const wrongChannel = channelOwner.admitInbound(
      inboundPacket({
        controller: channelOwner,
        kind: FRAME_KIND.REGISTER,
        channelId: requestHex(99),
      }),
      "channel",
      1n,
    );
    expect(wrongChannel.snapshot.fault).toBe("channel-id");

    const oldGeneration = loading();
    const old = inboundPacket({
      controller: oldGeneration,
      kind: FRAME_KIND.REGISTER,
      generation: 2n,
    });
    expect(oldGeneration.admitInbound(old, "generation", 1n).snapshot.fault).toBe(
      "generation-mismatch",
    );

    const wrongSequence = loading();
    const sequence = inboundPacket({
      controller: wrongSequence,
      kind: FRAME_KIND.REGISTER,
      sequence: 3n,
    });
    expect(wrongSequence.admitInbound(sequence, "sequence", 1n).snapshot.fault).toBe(
      "sequence-mismatch",
    );
  });

  it("rejects authenticated bodyless and per-kind-cap violations", () => {
    const bodyless = loading();
    const packet = inboundPacket({
      controller: bodyless,
      kind: FRAME_KIND.REGISTER,
      body: Buffer.from([1]),
    });
    packet[6] = FRAME_KIND.REGISTER_DONE;
    retag(bodyless, packet);
    expect(bodyless.admitInbound(packet, "bodyless", 1n).snapshot.fault).toBe("bodyless-kind");
    expect(() =>
      inboundPacket({
        controller: loading(),
        kind: FRAME_KIND.REGISTER,
        body: Buffer.alloc(REGISTER_BODY_CAP + 1),
      }),
    ).toThrow("body-cap");
  });

  it("owns authenticated bytes before queueing and never exposes decoded content", () => {
    const controller = loading();
    const packet = inboundPacket({
      controller,
      kind: FRAME_KIND.REGISTER,
      body: Buffer.from([1, 2, 3]),
    });
    const admitted = controller.admitInbound(packet, "owned", 1n);
    packet.fill(0);
    expect(admitted.snapshot.inboundQueued).toBe(1);
    const processed = controller.processInbound("owned");
    expect(processed.snapshot.registrationBytes).toBe(3);
    expect("body" in processed.snapshot).toBe(false);
  });

  it("enforces retained RESULT binding and closes on a second terminal", () => {
    const controller = active();
    const unknown = inboundPacket({
      controller,
      kind: FRAME_KIND.RESULT,
      requestId: requestHex(1),
      deadlineNs: 1_000n,
    });
    expect(controller.admitInbound(unknown, "unknown", 2n).snapshot.fault).toBe(
      "authenticated-request-binding",
    );
  });

  it("enforces unsigned bounds, sentinel, and INVOKE deadline at worker encoder", () => {
    const base = {
      kind: FRAME_KIND.RESULT,
      channelId,
      bootEpoch: Buffer.alloc(16, 1),
      generation: 1n,
      sequence: 1n,
      requestId: Buffer.from(requestHex(1), "hex"),
      deadlineNs: 100n,
      body: Buffer.alloc(0),
    } as const;
    expect(() => encodeWorkerFrame({ ...base, generation: 0n }, { key, nowNs: 1n })).toThrow(
      "generation",
    );
    expect(() => encodeWorkerFrame({ ...base, sequence: UINT64_MAX }, { key, nowNs: 1n })).toThrow(
      "sequence-exhausted",
    );
    expect(MAX_DEADLINE_AHEAD_NS).toBe(300_000_000_000n);
  });
});
