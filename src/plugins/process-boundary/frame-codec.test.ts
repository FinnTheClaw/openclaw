import { describe, expect, it } from "vitest";
import {
  FRAME_HEADER_BYTES,
  FRAME_KIND,
  bootEpoch,
  channelId,
  deadlineNs,
  encodeWorkerFrame,
  expectCode,
  frame,
  key,
  nowNs,
  packet,
  requestId,
} from "./frame-codec.test-helpers.js";
import { active, requestInvoke, sendFrame } from "./session-fsm.test-helpers.js";

describe("C07 raw process-boundary frame codec", () => {
  it("freezes every header offset and unsigned big-endian field", () => {
    const body = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const value = packet(FRAME_KIND.RESULT, body);
    expect(value.length).toBe(132);
    expect(value.subarray(0, 4).toString("ascii")).toBe("OCPB");
    expect(value.readUInt16BE(4)).toBe(1);
    expect(value[6]).toBe(FRAME_KIND.RESULT);
    expect(value[7]).toBe(0);
    expect(value.readUInt32BE(8)).toBe(0);
    expect(value.readUInt32BE(12)).toBe(4);
    expect(value.subarray(16, 32)).toEqual(channelId);
    expect(value.subarray(32, 48)).toEqual(bootEpoch);
    expect(value.readBigUInt64BE(48)).toBe(0x0102030405060708n);
    expect(value.readBigUInt64BE(56)).toBe(0x1112131415161718n);
    expect(value.subarray(64, 80)).toEqual(requestId);
    expect(value.readBigUInt64BE(80)).toBe(deadlineNs);
    expect(value.subarray(88, 96)).toEqual(Buffer.alloc(8));
    expect(value.subarray(96, FRAME_HEADER_BYTES)).toHaveLength(32);
    expect(value.subarray(FRAME_HEADER_BYTES)).toEqual(body);
  });

  it("owns every mutable worker encode input", () => {
    const localChannel = Buffer.from(channelId);
    const localBoot = Buffer.from(bootEpoch);
    const localKey = Buffer.from(key);
    const localRequest = Buffer.from(requestId);
    const localBody = Buffer.from([1, 2, 3]);
    const encoded = encodeWorkerFrame(
      {
        ...frame(FRAME_KIND.RESULT, localBody),
        channelId: localChannel,
        bootEpoch: localBoot,
        requestId: localRequest,
      },
      { key: localKey, nowNs, requestBinding: { requestId: localRequest, deadlineNs } },
    );
    localChannel.fill(0xff);
    localBoot.fill(0xff);
    localKey.fill(0xff);
    localRequest.fill(0xff);
    localBody.fill(0xff);
    expect(encoded.subarray(16, 32)).toEqual(channelId);
    expect(encoded.subarray(32, 48)).toEqual(bootEpoch);
    expect(encoded.subarray(64, 80)).toEqual(requestId);
    expect(encoded.subarray(128)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects every direct supervisor-direction encode", () => {
    for (const kind of [
      FRAME_KIND.LOAD_PACKAGE,
      FRAME_KIND.REGISTER_ACCEPT,
      FRAME_KIND.INVOKE,
      FRAME_KIND.CANCEL,
      FRAME_KIND.DRAIN,
    ]) {
      expectCode(
        () =>
          encodeWorkerFrame(
            {
              ...frame(kind),
              ...(kind === FRAME_KIND.INVOKE || kind === FRAME_KIND.CANCEL
                ? { requestId, deadlineNs }
                : {}),
            },
            { key, nowNs },
          ),
        "direction",
      );
    }
  });

  it("releases supervisor bytes only through the owning transport facade", () => {
    const controller = active();
    const prepared = requestInvoke(controller, 1, 2n, 1_000n, Buffer.from([7]));
    const token = sendFrame(prepared);
    expect(Object.keys(token)).toEqual([]);
    const taken = controller.transport.takeForSend(token, 2n);
    expect(taken.packet?.[6]).toBe(FRAME_KIND.INVOKE);
    expect(taken.packet?.subarray(128)).toEqual(Buffer.from([7]));
    expect(controller.transport.takeForSend(token, 2n).packet).toBeUndefined();
  });
});
