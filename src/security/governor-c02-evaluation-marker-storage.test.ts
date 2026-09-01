import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseC02EvaluationSession } from "./governor-c02-evaluation.js";
import { createC02EvaluationRestartMarkers } from "./governor-c02-local-evaluator.js";

describe("C02 evaluation marker storage", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c02-marker-anchor-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps publication in the held Linux directory or fails closed after a parent swap", () => {
    const item = parseC02EvaluationSession("c02-eval:C02-F-001:efefefefefefefefefefefef");
    if (!item) {
      throw new Error("expected evaluation");
    }
    const root = path.join(stateDir, "anchored-state");
    const moved = path.join(stateDir, "moved-state");
    const pending = `c02-f-001-${item.requestNonce}.pending.json`;
    fs.mkdirSync(root, { mode: 0o700 });
    const mkdir = fs.mkdirSync.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation((...args) => {
      const result = mkdir(...args);
      if (!swapped && typeof args[0] === "string" && args[0].endsWith("/governor")) {
        fs.renameSync(root, moved);
        mkdir(root, { mode: 0o700 });
        swapped = true;
      }
      return result;
    });
    let armed = false;
    try {
      armed = createC02EvaluationRestartMarkers({ stateDir: root }).arm(item, 0);
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    if (armed) {
      expect(fs.existsSync(path.join(moved, "governor", "c02-eval-restarts", pending))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, "governor", "c02-eval-restarts", pending))).toBe(false);
  });
});
