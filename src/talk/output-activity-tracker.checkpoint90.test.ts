import { describe, expect, it } from "vitest";
import { createRealtimeVoiceOutputActivityTracker } from "./output-activity-tracker.js";

describe("ST09 stream-local output activity", () => {
  it("01 fresh stream is silent", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markStreamOpened();
    expect(tracker.isActive()).toBe(false);
  });
  it("02 audio activates its stream", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 100 });
    expect(tracker.isActive()).toBe(true);
  });
  it("03 next silent stream is inactive", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100 });
    tracker.markStreamOpened();
    expect(tracker.isActive()).toBe(false);
  });
  it("04 next silent stream is not interruptible", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100 });
    tracker.markStreamOpened();
    expect(tracker.isInterruptible()).toBe(false);
  });
  it("05 next silent stream has no playback watchdog", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker({ now: () => 100 });
    tracker.markAudio({ audioMs: 200 });
    tracker.markStreamOpened();
    tracker.markPlaybackStarted();
    expect(tracker.playbackWatchdogDelayMs({ marginMs: 10 })).toBeUndefined();
  });
  it("06 second stream audio restores activity", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100 });
    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 25 });
    expect(tracker.isActive()).toBe(true);
    expect(tracker.isInterruptible()).toBe(true);
  });
  it("07 snapshot keeps cumulative totals", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100, sourceAudioBytes: 4 });
    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 25, sinkAudioBytes: 6 });
    expect(tracker.snapshot()).toMatchObject({
      audioMs: 125,
      chunks: 2,
      sourceAudioBytes: 4,
      sinkAudioBytes: 6,
    });
  });
  it("08 active sink still overrides silent stream", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100 });
    tracker.markStreamOpened();
    expect(tracker.isActive(true)).toBe(true);
    expect(tracker.isInterruptible(true)).toBe(true);
  });
  it("09 explicit reset clears cumulative and stream-local activity", () => {
    const tracker = createRealtimeVoiceOutputActivityTracker();
    tracker.markAudio({ audioMs: 100 });
    tracker.reset();
    expect(tracker.snapshot().audioMs).toBe(0);
    expect(tracker.isActive()).toBe(false);
  });
  it("10 three streams count only latest activity for watchdog", () => {
    let time = 100;
    const tracker = createRealtimeVoiceOutputActivityTracker({ now: () => time });
    tracker.markAudio({ audioMs: 1000 });
    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 2000 });
    tracker.markStreamOpened();
    tracker.markAudio({ audioMs: 30 });
    tracker.markPlaybackStarted();
    time += 5;
    expect(tracker.playbackWatchdogDelayMs({ marginMs: 20, minMs: 1 })).toBe(45);
    expect(tracker.snapshot().audioMs).toBe(3030);
  });
});
