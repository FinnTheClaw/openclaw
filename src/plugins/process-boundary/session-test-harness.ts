import { decodeKeyInstall } from "./bootstrap-codec.js";
import {
  FRAME_KIND,
  UINT64_MAX,
  encodeWorkerFrame,
  type FrameKind,
  type PreparedFrame,
} from "./frame-codec.js";
import {
  MAX_REGISTRATIONS,
  installSessionGeneration,
  type ControllerResult,
  type SessionIngressPort,
  type SessionLifecyclePort,
  type SessionObserver,
  type SessionTransportPort,
  type SessionWorkPort,
} from "./session-fsm.js";
import type { SessionEvent, SessionSnapshot } from "./session-state.js";

export const epochHex = "ffeeddccbbaa99887766554433221100";

type Peer = {
  key: Buffer;
  channelId: Buffer;
  bootEpoch: Buffer;
  generation: bigint;
  nextSequence: bigint | null;
};
export type TestFacets = {
  observer: SessionObserver;
  work: SessionWorkPort;
  ingress: SessionIngressPort;
  transport: SessionTransportPort;
  lifecycle: SessionLifecyclePort;
};
export type SessionController = Readonly<{
  snapshot(): SessionSnapshot;
  dispatch(event: SessionEvent): ControllerResult;
  admitInbound(packet: Uint8Array, id: string, nowNs: bigint): ControllerResult;
  processInbound(
    id: string,
    options?: Readonly<{ nowNs?: bigint; inventoryMatches?: boolean }>,
  ): ControllerResult;
  transport: Readonly<{
    takeForSend(
      frame: PreparedFrame,
      nowNs: bigint,
    ): Readonly<{ packet?: Buffer; result: ControllerResult }>;
    commitSent(frame: PreparedFrame, nowNs: bigint): ControllerResult;
  }>;
}>;

const peers = new WeakMap<SessionController, Peer>();
const facetSets = new WeakMap<SessionController, TestFacets>();
function peerFor(controller: SessionController): Peer {
  const peer = peers.get(controller);
  if (!peer) {
    throw new Error("test-peer-not-keyed");
  }
  return peer;
}
export function peerContext(controller: SessionController) {
  const peer = peerFor(controller);
  return {
    key: Buffer.from(peer.key),
    channelId: Buffer.from(peer.channelId),
    bootEpoch: Buffer.from(peer.bootEpoch),
    generation: peer.generation,
  };
}
export function testFacets(controller: SessionController): TestFacets {
  const facets = facetSets.get(controller);
  if (!facets) {
    throw new Error("test-facets-missing");
  }
  return facets;
}

export function createTestSession(limit = MAX_REGISTRATIONS, generation = 1n): SessionController {
  let nowNs = 0n;
  let peer: Peer | undefined;
  const bound: Partial<TestFacets> = {};
  const holder: { controller?: SessionController } = {};
  installSessionGeneration(
    { generation, bootEpoch: epochHex, registrationLimit: limit },
    {
      clock: { nowNs: () => nowNs },
      deliverKeyInstall(packet) {
        const value = decodeKeyInstall(packet);
        peer = {
          key: Buffer.from(value.key),
          channelId: Buffer.from(value.channelId),
          bootEpoch: Buffer.from(value.bootEpoch),
          generation: value.generation,
          nextSequence: 1n,
        };
        if (holder.controller) {
          peers.set(holder.controller, peer);
        }
        return true;
      },
      bindObserver: (port) => (bound.observer = port),
      bindWork: (port) => (bound.work = port),
      bindIngress: (port) => (bound.ingress = port),
      bindTransport: (port) => (bound.transport = port),
      bindLifecycle: (port) => (bound.lifecycle = port),
    },
  );
  const facets = bound as TestFacets;
  const setNow = (value: bigint | undefined) => {
    if (value !== undefined) {
      nowNs = value;
    }
  };
  const dispatch = (event: SessionEvent): ControllerResult => {
    if ("nowNs" in event) {
      setNow(event.nowNs);
    }
    switch (event.type) {
      case "LOCAL_CONNECTION":
        return facets.lifecycle.connected();
      case "LOCAL_ATTESTED":
        return facets.lifecycle.attested();
      case "LOCAL_INVOKE":
        return facets.work.invoke(event);
      case "LOCAL_TERMINAL":
        return facets.work.terminal(event);
      case "LOCAL_START_DRAIN":
        return facets.work.startDrain();
      case "LOCAL_DRAIN_GRACE_EXPIRED":
        return facets.lifecycle.drainGraceExpired();
      case "LOCAL_FAULT":
        return facets.lifecycle.fail();
      case "LOCAL_CLEANUP_PROGRESS":
        return facets.lifecycle.cleanupProgress(event.completed);
      case "LOCAL_EXIT_PROOF":
        return facets.lifecycle.exitProof();
      case "LOCAL_CLEANUP_UNCERTAIN":
        return facets.lifecycle.cleanupUncertain();
    }
  };
  const created: SessionController = Object.freeze({
    snapshot: facets.observer.snapshot,
    dispatch,
    admitInbound(packet: Uint8Array, id: string, value: bigint) {
      setNow(value);
      const before = facets.observer.snapshot().inboundQueued;
      const result = facets.ingress.admit(packet, id);
      if (result.snapshot.inboundQueued > before) {
        const current = peerFor(created).nextSequence;
        peerFor(created).nextSequence = current === UINT64_MAX - 1n ? null : current! + 1n;
      }
      return result;
    },
    processInbound(id: string, options = {}) {
      setNow(options.nowNs);
      return facets.ingress.process(
        id,
        options.inventoryMatches === undefined
          ? {}
          : { inventoryMatches: options.inventoryMatches },
      );
    },
    transport: Object.freeze({
      takeForSend(frame: PreparedFrame, value: bigint) {
        setNow(value);
        return facets.transport.takeForSend(frame);
      },
      commitSent(frame: PreparedFrame, value: bigint) {
        setNow(value);
        return facets.transport.commitSent(frame);
      },
    }),
  });
  holder.controller = created;
  facetSets.set(created, facets);
  if (peer) {
    peers.set(created, peer);
  }
  return created;
}

export function inboundPacket(params: {
  controller: SessionController;
  kind: FrameKind;
  sequence?: bigint;
  requestId?: string;
  deadlineNs?: bigint;
  body?: Uint8Array;
  generation?: bigint;
  channelId?: string;
  nowNs?: bigint;
}): Buffer {
  const peer = peerFor(params.controller);
  const body =
    params.body ?? (params.kind === FRAME_KIND.REGISTER ? Buffer.from([1]) : Buffer.alloc(0));
  return encodeWorkerFrame(
    {
      kind: params.kind,
      channelId: params.channelId ? Buffer.from(params.channelId, "hex") : peer.channelId,
      bootEpoch: peer.bootEpoch,
      generation: params.generation ?? peer.generation,
      sequence: params.sequence ?? peer.nextSequence ?? UINT64_MAX,
      ...(params.requestId ? { requestId: Buffer.from(params.requestId, "hex") } : {}),
      ...(params.deadlineNs === undefined ? {} : { deadlineNs: params.deadlineNs }),
      body,
    },
    { key: peer.key, nowNs: params.nowNs ?? 1n },
  );
}
