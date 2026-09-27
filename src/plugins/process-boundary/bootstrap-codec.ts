const UINT64_MAX = (1n << 64n) - 1n;

export type KeyInstall = Readonly<{
  channelId: Uint8Array;
  bootEpoch: Uint8Array;
  generation: bigint;
  key: Uint8Array;
}>;

export class BootstrapProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BootstrapProtocolError";
  }
}

function fail(code: string): never {
  throw new BootstrapProtocolError(code);
}

function copyExact(value: Uint8Array, length: number, code: string): Buffer {
  if (value.byteLength !== length) {
    fail(code);
  }
  return Buffer.from(value);
}

function requireExact(value: Uint8Array, length: number, code: string): void {
  if (value.byteLength !== length) {
    fail(code);
  }
}

function requireGeneration(value: bigint): void {
  if (value < 1n || value > UINT64_MAX) {
    fail("generation");
  }
}

export function encodeBootstrapLive(): Buffer {
  const packet = Buffer.alloc(32);
  packet.write("OCB0", 0, "ascii");
  packet.writeUInt16BE(1, 4);
  packet[6] = 1;
  return packet;
}

export function decodeBootstrapLive(bytes: Uint8Array): void {
  if (bytes.byteLength !== 32) {
    fail("bootstrap-live");
  }
  const packet = Buffer.from(bytes);
  const reserved = packet.subarray(7);
  if (
    packet.subarray(0, 4).toString("ascii") !== "OCB0" ||
    packet.readUInt16BE(4) !== 1 ||
    packet[6] !== 1 ||
    !reserved.equals(Buffer.alloc(25))
  ) {
    fail("bootstrap-live");
  }
}

export function encodeKeyInstall(value: KeyInstall): Buffer {
  const channelId = copyExact(value.channelId, 16, "channel-id-length");
  const bootEpoch = copyExact(value.bootEpoch, 16, "boot-epoch-length");
  requireExact(value.key, 32, "key-length");
  requireGeneration(value.generation);

  const packet = Buffer.alloc(80);
  packet.write("OCK0", 0, "ascii");
  packet.writeUInt16BE(1, 4);
  packet[6] = 2;
  channelId.copy(packet, 8);
  bootEpoch.copy(packet, 24);
  packet.writeBigUInt64BE(value.generation, 40);
  packet.set(value.key, 48);
  return packet;
}

export function decodeKeyInstall(bytes: Uint8Array): KeyInstall {
  const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (packet.byteLength !== 80) {
      fail("key-install");
    }
    if (
      packet.subarray(0, 4).toString("ascii") !== "OCK0" ||
      packet.readUInt16BE(4) !== 1 ||
      packet[6] !== 2 ||
      packet[7] !== 0
    ) {
      fail("key-install");
    }
    const generation = packet.readBigUInt64BE(40);
    requireGeneration(generation);

    return {
      channelId: Buffer.from(packet.subarray(8, 24)),
      bootEpoch: Buffer.from(packet.subarray(24, 40)),
      generation,
      key: Buffer.from(packet.subarray(48, 80)),
    };
  } finally {
    if (packet.byteLength > 48) {
      packet.fill(0, 48, Math.min(80, packet.byteLength));
    }
  }
}
