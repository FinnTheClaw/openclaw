import { describe, expect, it } from "vitest";
import {
  C07_PLUGIN_PROCESS_MAX_FRAME_BYTES,
  C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
  parseC07PluginHostFrame,
  parseC07PluginWorkerFrame,
} from "./governor-memory-plugin-process-protocol.js";

const digest = "a".repeat(64);

describe("C07 plugin process protocol", () => {
  it("accepts only closed, bounded host frames", () => {
    const invoke = {
      type: "invoke",
      version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
      bootEpoch: digest,
      requestId: "b".repeat(64),
      sequence: 1,
      payload: { operation: "project", values: [1, true, null] },
    };
    expect(parseC07PluginHostFrame(invoke)).toEqual(invoke);
    expect(() => parseC07PluginHostFrame({ ...invoke, authorityKey: "forbidden" })).toThrow(
      "C07_PLUGIN_PROCESS_FRAME_INVALID",
    );
    expect(() =>
      parseC07PluginHostFrame({
        ...invoke,
        payload: "x".repeat(C07_PLUGIN_PROCESS_MAX_FRAME_BYTES),
      }),
    ).toThrow("C07_PLUGIN_PROCESS_FRAME_TOO_LARGE");
  });

  it("accepts attested ready and exact success/failure results", () => {
    const ready = {
      type: "ready",
      version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
      bootEpoch: digest,
      pid: 42,
      uid: 1001,
      gid: 1001,
      groups: [1001],
      implementationDigest: "c".repeat(64),
    };
    expect(parseC07PluginWorkerFrame(ready)).toEqual(ready);
    expect(
      parseC07PluginWorkerFrame({
        type: "result",
        version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
        bootEpoch: digest,
        requestId: "d".repeat(64),
        sequence: 2,
        ok: true,
        payload: { applied: true },
      }),
    ).toMatchObject({ ok: true, payload: { applied: true } });
    expect(() => parseC07PluginWorkerFrame({ ...ready, pid: 0 })).toThrow(
      "C07_PLUGIN_PROCESS_FRAME_INVALID",
    );
  });

  it("rejects non-JSON, overdeep, and ambiguous result shapes", () => {
    const base = {
      type: "result",
      version: C07_PLUGIN_PROCESS_PROTOCOL_VERSION,
      bootEpoch: digest,
      requestId: "e".repeat(64),
      sequence: 1,
      ok: true,
    };
    let nested: unknown = null;
    for (let depth = 0; depth < 34; depth += 1) {
      nested = [nested];
    }
    expect(() => parseC07PluginWorkerFrame({ ...base, payload: nested })).toThrow(
      "C07_PLUGIN_PROCESS_FRAME_INVALID",
    );
    expect(() =>
      parseC07PluginWorkerFrame({
        ...base,
        payload: { ok: true },
        errorCode: "PLUGIN_RESULT_INVALID",
      }),
    ).toThrow("C07_PLUGIN_PROCESS_FRAME_INVALID");
  });
});
