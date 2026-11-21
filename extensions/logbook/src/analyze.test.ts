import { assert, describe, expect, it } from "vitest";
import {
  parseCardsJson,
  parseObservationSegments,
  revisionWindow,
  selectBatchFrames,
  validateCardCoverage,
} from "./analyze.js";

const DAY = "2026-07-03";
const dayMs = (clock: string) => new Date(`${DAY}T${clock}`).getTime();
const content = { title: "t", summary: "s", detail: "", category: "coding", distractions: [] };
function expectError(
  result: ReturnType<typeof parseCardsJson> | ReturnType<typeof validateCardCoverage>,
  message: string,
) {
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
}

describe("parseObservationSegments", () => {
  const startMs = dayMs("10:00:00");
  const endMs = dayMs("10:15:00");
  const parse = (raw: string, window = { startMs, endMs }, day = DAY) =>
    parseObservationSegments({ raw, day, ...window });

  it("parses and clamps segments into the batch window", () => {
    const raw = JSON.stringify({
      segments: [
        { start: "09:55:00", end: "10:05:00", description: "VS Code: editing store.ts" },
        { start: "10:05:00", end: "10:20:00", description: "Chrome: reviewing PR #99" },
      ],
    });
    expect(parse(raw)).toEqual([
      expect.objectContaining({ startMs }),
      expect.objectContaining({ endMs }),
    ]);
  });

  it("returns empty on unparseable output", () => {
    expect(parse("no json here")).toEqual([]);
  });

  it("parses 12h clocks from fenced model output", () => {
    const raw =
      'Here you go:\n```json\n{"segments":[{"start":"1:05 pm","end":"1:05:30 pm","description":"Reviewing the timeline"}]}\n```\nHope that helps!';
    expect(parse(raw, { startMs: dayMs("13:00:00"), endMs: dayMs("13:10:00") })).toEqual([
      expect.objectContaining({ startMs: dayMs("13:05:00"), endMs: dayMs("13:05:30") }),
    ]);
  });

  it.each([
    [DAY, "25:00:00"],
    [DAY, "half past nine"],
    ["not-a-day", "10:00:00"],
  ])("rejects malformed clock %s %s", (day, clock) => {
    const raw = JSON.stringify([{ start: clock, end: "13:06:00", description: "Invalid clock" }]);
    expect(parse(raw, undefined, day)).toEqual([]);
  });
});

describe("parseCardsJson", () => {
  const card = (overrides: Record<string, unknown> = {}) => ({
    startTime: "10:00:00",
    endTime: "10:30:00",
    ...content,
    detailedSummary: "Added frames and cards tables.",
    appSites: { primary: "github.com" },
    ...overrides,
  });
  const parse = (...cards: ReturnType<typeof card>[]) =>
    parseCardsJson({ raw: JSON.stringify(cards), day: DAY });
  const overlap = (firstEnd: string, secondEnd = "11:00:00") =>
    parse(card({ endTime: firstEnd }), card({ startTime: "10:30:00", endTime: secondEnd }));

  it("maps unknown categories to other", () => {
    expect(parse(card({ category: "quantum-vibes" }))).toMatchObject({
      ok: true,
      drafts: [{ category: "other" }],
    });
  });

  it("trims sub-minute overlaps", () => {
    expect(overlap("10:30:30")).toMatchObject({
      ok: true,
      drafts: [{ endMs: dayMs("10:30:30") }, { startMs: dayMs("10:30:30") }],
    });
  });

  it.each([
    [() => overlap("10:45:00"), "overlap"],
    [() => overlap("10:30:30", "10:30:30"), "endTime"],
    [() => parse(card({ startTime: "13:05 pm" })), "startTime"],
  ] as const)("reports actionable card errors: %s", (parseInvalid, error) => {
    expectError(parseInvalid(), error);
  });

  it("orders model cards before validating revision coverage", () => {
    const result = parse(card({ startTime: "10:30:00", endTime: "11:00:00" }), card());
    assert(result.ok);
    expect(coverage(result.drafts)).toEqual({ ok: true });
  });
});

function select(offsets: number[], now: number, force = false, t0 = dayMs("10:00:00")) {
  return selectBatchFrames({
    frames: offsets.map((seconds, i) => ({ id: i + 1, capturedAtMs: t0 + seconds * 1000 })),
    windowMs: 900_000,
    nowMs: t0 + now,
    force,
  });
}
type SelectionCase = [string, number[], number, boolean, number[] | null, number, number?];
it.each<SelectionCase>([
  ["elapsed boundary", [0, 30, 60, 900], 901_000, false, [1, 2, 3], 900_000],
  ["capture gap", [0, 30, 400], 60_000, false, [1, 2], 30_001],
  ["pending window", [0, 30], 60_000, false, null, 0],
  ["forced window", [0, 30], 60_000, true, [1, 2], 30_001],
  ...["2026-07-03", "2026-03-08", "2026-11-01"].map((day): SelectionCase => [
    `midnight ${day}`,
    [0, 30, 60],
    60_000,
    false,
    [1, 2],
    30_001,
    new Date(`${day}T23:59:00`).getTime(),
  ]),
])("selectBatchFrames: %s", (_name, offsets, now, force, ids, end, t0 = dayMs("10:00:00")) => {
  expect(select(offsets, now, force, t0)).toEqual(
    ids ? { frameIds: ids, startMs: t0, endMs: t0 + end } : null,
  );
});

type Span = [number, number];
const span = ([start, end]: Span) => ({
  startMs: dayMs("10:00:00") + start * 60_000,
  endMs: dayMs("10:00:00") + end * 60_000,
});
const coverageWindow = { windowStartMs: dayMs("10:00:00"), windowEndMs: dayMs("11:00:00") };
type Intervals = ReturnType<typeof span>[];
const coverage = (drafts: Intervals, requiredSpans = [span([0, 60])]) =>
  validateCardCoverage({ drafts, requiredSpans, ...coverageWindow });
it.each<[Intervals, Intervals, string | null]>([
  [[span([30, 60])], [span([0, 30]), span([30, 60])], "not covered"],
  [[span([-60, 60])], [span([0, 60])], "outside the revision window"],
  [[span([0, 29]), span([30.5, 60])], [span([0, 60])], null],
])("validates card coverage: %j over %j", (drafts, required, error) => {
  expect(coverage(drafts, required)).toMatchObject(
    error ? { ok: false, error: expect.stringContaining(error) } : { ok: true },
  );
});

it("expands the revision window to cover previous draft cards", () => {
  expect(
    revisionWindow({
      batchStartMs: dayMs("10:30:00"),
      batchEndMs: dayMs("10:45:00"),
      previousCards: [{ id: 1, day: DAY, ...span([0, 30]), ...content }],
    }),
  ).toEqual({ startMs: dayMs("10:00:00"), endMs: dayMs("10:45:00") });
});

it.each(["10:30:15", "10:30:30"])(
  "rejects overlaps that leave no positive duration after trimming: %s",
  (endTime) => {
    const result = parseCardsJson({
      raw: JSON.stringify([
        card({ startTime: "10:00:00", endTime: "10:30:30" }),
        card({ startTime: "10:30:00", endTime, title: "Contained" }),
      ]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(result.ok).toBe(false);
  },
);

describe("midnight batch endpoint", () => {
  const midnight = new Date(DAY + "T00:00:00");
  midnight.setDate(midnight.getDate() + 1);
  const batch = expectDefined(
    selectBatchFrames({
      frames: [{ id: 1, capturedAtMs: dayMs("23:59:30") }],
      windowMs: 15 * 60 * 1000,
      nowMs: midnight.getTime(),
    }),
    "elapsed batch ending at midnight",
  );

  it("preserves a midnight observation endpoint in the selected batch", () => {
    const segments = parseObservationSegments({
      raw: JSON.stringify([
        { start: "23:59:30", end: "00:00:00", description: "Finishing a review" },
      ]),
      day: DAY,
      startMs: batch.startMs,
      endMs: batch.endMs,
    });

    expect(segments).toEqual([
      { startMs: dayMs("23:59:30"), endMs: midnight.getTime(), text: "Finishing a review" },
    ]);
  });

  it("accepts a card covering the selected batch through midnight", () => {
    const result = parseCardsJson({
      raw: JSON.stringify([
        {
          startTime: "23:59:30",
          endTime: "00:00:00",
          title: "Finishing a review",
          summary: "Reviewed the final changes",
          distractions: [
            { startTime: "23:59:45", endTime: "00:00:00", title: "Checking a notification" },
          ],
        },
      ]),
      day: DAY,
      windowStartMs: batch.startMs,
      windowEndMs: batch.endMs,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const draft = expectDefined(result.drafts[0], "midnight card");
      expect(draft.endMs).toBe(midnight.getTime());
      expect(draft.distractions).toEqual([
        {
          startMs: dayMs("23:59:45"),
          endMs: midnight.getTime(),
          title: "Checking a notification",
        },
      ]);
    }
  });

  it("keeps midnight start and end clocks on their own day in an early batch", () => {
    const segments = parseObservationSegments({
      raw: JSON.stringify([
        { start: "00:00:00", end: "00:00:30", description: "Starting a review" },
      ]),
      day: DAY,
      startMs: dayMs("00:00:00"),
      endMs: dayMs("00:01:00"),
    });

    expect(segments).toEqual([
      {
        startMs: dayMs("00:00:00"),
        endMs: dayMs("00:00:30"),
        text: "Starting a review",
      },
    ]);
  });

  it("does not reinterpret an inverted end clock in a daytime revision window", () => {
    expect(
      parseCardsJson({
        raw: JSON.stringify([
          {
            startTime: "10:00:00",
            endTime: "00:00:00",
            title: "Invalid interval",
            summary: "This end precedes the start",
          },
        ]),
        day: DAY,
        windowStartMs: dayMs("10:00:00"),
        windowEndMs: dayMs("11:00:00"),
      }).ok,
    ).toBe(false);
  });

  it("uses following local midnight on both DST transition days", () => {
    const moduleUrl = new URL("./analyze.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        `const { parseObservationSegments } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(["2026-03-08", "2026-11-01"].map(day => { const startMs = new Date(day + "T23:59:30").getTime(); const end = new Date(day + "T00:00:00"); end.setHours(24, 0, 0, 0); return parseObservationSegments({ raw: JSON.stringify([{ start: "23:59:30", end: "00:00:00", description: "x" }]), day, startMs, endMs: end.getTime() })[0]?.endMs ?? null; })));`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: "America/New_York" } },
    );

    expect(JSON.parse(output)).toEqual([Date.UTC(2026, 2, 9, 4), Date.UTC(2026, 10, 2, 5)]);
  });
});
