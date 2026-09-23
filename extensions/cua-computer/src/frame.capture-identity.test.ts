import { describe, expect, it } from "vitest";
import { adoptGeneration, issueFrame, verifyFrame, type CuaFrameState } from "./frame.js";

const geometry = {
  platform: "linux",
  display: "primary",
  screenWidth: 1600,
  screenHeight: 900,
  scaleFactor: 1,
  screenshotWidth: 1600,
  screenshotHeight: 900,
};
const capture = { width: 800, height: 450, referenceWidth: 1600 };
const screen = { width: 1600, height: 900, scaleFactor: 1 };
const state = (): CuaFrameState => ({ generation: "g1" });

describe("CUA capture identity", () => {
  it("issues distinct IDs for same-size consecutive captures", () => {
    const s = state();
    expect(issueFrame(s, geometry, capture)).not.toBe(issueFrame(s, geometry, capture));
  });
  it("rejects the older ID after a second capture", () => {
    const s = state();
    const old = issueFrame(s, geometry, capture);
    issueFrame(s, geometry, capture);
    expect(() => verifyFrame(s, old, screen, 1600)).toThrow(/COMPUTER_STALE_FRAME/u);
  });
  it("accepts the latest ID", () => {
    const s = state();
    issueFrame(s, geometry, capture);
    const latest = issueFrame(s, geometry, capture);
    expect(verifyFrame(s, latest, screen, 1600).id).toBe(latest);
  });
  it("rejects changed live geometry", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    expect(() => verifyFrame(s, id, { ...screen, width: 1599 }, 1600)).toThrow(
      /COMPUTER_STALE_FRAME/u,
    );
  });
  it("rejects a prior generation", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    adoptGeneration(s, "g2");
    expect(() => verifyFrame(s, id, screen, 1600)).toThrow(/COMPUTER_STALE_FRAME/u);
  });
  it("rejects an unrelated width", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    expect(() => verifyFrame(s, id, screen, 799)).toThrow(/COMPUTER_STALE_FRAME/u);
  });
  it("accepts the delivered bitmap width", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    expect(verifyFrame(s, id, screen, 800).id).toBe(id);
  });
  it("accepts the requested reference width", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    expect(verifyFrame(s, id, screen, 1600).id).toBe(id);
  });
  it("clears the frame after a stale action", () => {
    const s = state();
    const id = issueFrame(s, geometry, capture);
    expect(() => verifyFrame(s, "stale", screen, 1600)).toThrow();
    expect(() => verifyFrame(s, id, screen, 1600)).toThrow(/COMPUTER_STALE_FRAME/u);
  });
  it("issues distinct IDs across separate states", () => {
    expect(issueFrame(state(), geometry, capture)).not.toBe(issueFrame(state(), geometry, capture));
  });
});
