import { describe, expect, it } from "vitest";
import {
  BootstrapProtocolError,
  decodeBootstrapLive,
  decodeKeyInstall,
  encodeBootstrapLive,
  encodeKeyInstall,
} from "./bootstrap-codec.js";

const channelId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const bootEpoch = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
const key = Buffer.alloc(32, 0xa5);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected protocol error");
  } catch (error) {
    expect(error).toBeInstanceOf(BootstrapProtocolError);
    expect((error as BootstrapProtocolError).code).toBe(code);
  }
}

describe("C07 process-boundary bootstrap codec", () => {
  it("encodes and validates the exact 32-byte BOOTSTRAP_LIVE vector", () => {
    const value = encodeBootstrapLive();
    expect(value.toString("hex")).toBe(`4f434230000101${"00".repeat(25)}`);
    expect(decodeBootstrapLive(value)).toBeUndefined();

    for (const invalid of [value.subarray(0, 31), Buffer.concat([value, Buffer.from([0])])]) {
      expectCode(() => decodeBootstrapLive(invalid), "bootstrap-live");
    }
    const changed = Buffer.from(value);
    changed[7] = 1;
    expectCode(() => decodeBootstrapLive(changed), "bootstrap-live");
  });

  it("encodes, decodes, owns, and zeroizes the exact 80-byte KEY_INSTALL vector", () => {
    const install = encodeKeyInstall({
      channelId,
      bootEpoch,
      generation: 0x0102030405060708n,
      key,
    });
    expect(install.toString("hex")).toBe(
      `4f434b3000010200${channelId.toString("hex")}${bootEpoch.toString("hex")}` +
        `0102030405060708${key.toString("hex")}`,
    );
    const decoded = decodeKeyInstall(install);
    expect(install.subarray(48, 80)).toEqual(Buffer.alloc(32));
    install.fill(0);
    expect(Buffer.from(decoded.channelId)).toEqual(channelId);
    expect(Buffer.from(decoded.bootEpoch)).toEqual(bootEpoch);
    expect(decoded.generation).toBe(0x0102030405060708n);
    expect(Buffer.from(decoded.key)).toEqual(key);

    const invalid = encodeKeyInstall({ channelId, bootEpoch, generation: 1n, key });
    invalid[7] = 1;
    expectCode(() => decodeKeyInstall(invalid), "key-install");
    expect(invalid.subarray(48, 80)).toEqual(Buffer.alloc(32));
    const truncated = encodeKeyInstall({ channelId, bootEpoch, generation: 1n, key }).subarray(
      0,
      79,
    );
    expectCode(() => decodeKeyInstall(truncated), "key-install");
    expect(truncated.subarray(48)).toEqual(Buffer.alloc(31));
  });
});
