import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it.each([
    "after parent validation before child open",
    "after child open before leaf publication",
  ])("fails closed without publishing into a replacement root: %s", (interleaving) => {
    const item = parseC02EvaluationSession("c02-eval:C02-F-001:efefefefefefefefefefefef");
    if (!item) {
      throw new Error("expected evaluation");
    }
    const root = path.join(stateDir, "anchored-state");
    const moved = path.join(stateDir, "moved-state");
    const pending = `c02-f-001-${item.requestNonce}.pending.json`;
    fs.mkdirSync(root, { mode: 0o700 });
    let swapped = false;
    const swap = () => {
      if (!swapped) {
        fs.renameSync(root, moved);
        fs.mkdirSync(root, { mode: 0o700 });
        swapped = true;
      }
    };
    const hooks =
      interleaving === "after parent validation before child open"
        ? { afterParentValidationBeforeChildOpen: (name: string) => name === "governor" && swap() }
        : { afterChildOpenBeforeLeafPublication: swap };
    const armed = createC02EvaluationRestartMarkers({ stateDir: root, testHooks: hooks }).arm(
      item,
      0,
    );
    expect(swapped).toBe(true);
    expect(armed).toBe(false);
    expect(fs.existsSync(path.join(root, "governor", "c02-eval-restarts", pending))).toBe(false);
    expect(fs.existsSync(path.join(moved, "governor", "c02-eval-restarts", pending))).toBe(false);
  });
});
