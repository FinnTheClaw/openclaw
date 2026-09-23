import { describe, expect, it, vi } from "vitest";
import type { CuaComputerActParams } from "./action-targets.js";
import { driver, execution } from "./commands.test-helpers.js";
import { cuaToolResult } from "./cua-driver-contract.test-fixtures.js";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";
import type { CuaExecutionResources } from "./execution-resources.js";
import {
  closeRecordingExecution,
  handleRecordingAct,
  type CuaRecordingState,
} from "./recording-actions.js";

const stopped = {
  recording: false,
  enabled: false,
  output_dir: null,
  next_turn: 1,
  last_error: null,
  video_active: false,
  last_video_path: null,
  owner: null,
};
const activeNative = { ...stopped, recording: true, enabled: true };
function setup(responses: Array<CuaToolResult | Error> = [cuaToolResult(stopped)]) {
  const state: CuaRecordingState = { active: { resourceHandle: "owned-handle" } };
  const callTool = vi.fn(async () => {
    const response = responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response ?? cuaToolResult(stopped);
  });
  const discard = vi.fn(async () => {});
  const driver = { callTool } as unknown as CuaDriverSession;
  const resources = { discard } as unknown as CuaExecutionResources;
  const stop = () =>
    handleRecordingAct(driver, state, resources, {
      action: "stop_recording",
    } as CuaComputerActParams);
  const close = (reason = "cancel") =>
    closeRecordingExecution({ driver, state, resources, reason });
  return { state, callTool, discard, stop, close };
}
describe("ST08 owned recording stop", () => {
  it("01 public stop confirms and releases ownership", async () => {
    const h = setup();
    await expect(h.stop()).resolves.toContain('"recording":false');
    expect(h.state.active).toBeUndefined();
  });
  it("02 rejected public stop retains ownership", async () => {
    const h = setup([new Error("transient")]);
    await expect(h.stop()).rejects.toThrow("transient");
    expect(h.state.active?.resourceHandle).toBe("owned-handle");
  });
  it("03 driver isError retains ownership", async () => {
    const h = setup([{ ...cuaToolResult(stopped), isError: true }]);
    await expect(h.stop()).rejects.toThrow("stop_recording");
    expect(h.state.active?.resourceHandle).toBe("owned-handle");
  });
  it("04 malformed success retains ownership", async () => {
    const h = setup([cuaToolResult({})]);
    await expect(h.stop()).rejects.toThrow();
    expect(h.state.active?.resourceHandle).toBe("owned-handle");
  });
  it("05 transient public failure is retryable", async () => {
    const h = setup([new Error("transient"), cuaToolResult(stopped)]);
    await expect(h.stop()).rejects.toThrow("transient");
    await expect(h.stop()).resolves.toContain('"recording":false');
    expect(h.callTool).toHaveBeenCalledTimes(2);
  });
  it("06 failed execution close keeps the driver and permits same-session retry", async () => {
    const active = driver();
    let stopCalls = 0;
    active.callTool.mockImplementation(async (name) => {
      if (name === "start_recording") {
        return cuaToolResult(activeNative);
      }
      if (name === "stop_recording") {
        stopCalls++;
        if (stopCalls === 1) {
          throw new Error("transient");
        }
        return cuaToolResult(stopped);
      }
      return cuaToolResult(stopped);
    });
    const computer = await execution(active.session);
    await computer.act(JSON.stringify({ action: "start_recording" }));
    await expect(computer.close("cancel")).rejects.toThrow("transient");
    expect(active.dispose).not.toHaveBeenCalled();
    await expect(computer.close("cancel")).resolves.toBeUndefined();
    expect(stopCalls).toBe(2);
    expect(active.dispose).toHaveBeenCalledOnce();
  });
  it("07 rejected close retains ownership and does not discard", async () => {
    const h = setup([new Error("transient")]);
    await expect(h.close()).rejects.toThrow("transient");
    expect(h.state.active?.resourceHandle).toBe("owned-handle");
    expect(h.discard).not.toHaveBeenCalled();
  });
  it("08 successful close discards owned resource", async () => {
    const h = setup();
    await h.close();
    expect(h.state.active).toBeUndefined();
    expect(h.discard).toHaveBeenCalledWith("owned-handle");
  });
  it("09 no-active stop does not call driver", async () => {
    const h = setup();
    h.state.active = undefined;
    await expect(h.stop()).resolves.toContain('"recording":false');
    expect(h.callTool).not.toHaveBeenCalled();
  });
  it("10 still-active stop payload retains this session; no unrelated handle touched", async () => {
    const h = setup([cuaToolResult(activeNative)]);
    await expect(h.close()).rejects.toThrow("active state");
    expect(h.state.active?.resourceHandle).toBe("owned-handle");
    expect(h.discard).not.toHaveBeenCalled();
  });
});
