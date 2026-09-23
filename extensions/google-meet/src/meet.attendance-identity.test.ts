import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleMeetAttendance } from "./meet.js";
import { jsonResponse, requestUrl } from "./test-support/cli-harness.js";

type Person = {
  id: string;
  kind: "anonymousUser" | "phoneUser" | "signedinUser";
  display?: string;
  user?: string;
  start: number;
  minutes: number;
};
const name = (id: string) => `conferenceRecords/rec-1/participants/${id}`;
const time = (minute: number) => new Date(Date.UTC(2026, 3, 25, 10, minute)).toISOString();
const person = (
  id: string,
  kind: Person["kind"],
  display: string | undefined,
  start: number,
  minutes: number,
  user?: string,
): Person => ({ id, kind, display, start, minutes, user });
function stubApi(people: readonly Person[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/v2/conferenceRecords/rec-1") {
        return jsonResponse({
          name: "conferenceRecords/rec-1",
          startTime: time(0),
          endTime: time(60),
        });
      }
      if (path === "/v2/conferenceRecords/rec-1/participants") {
        return jsonResponse({
          participants: people.map((p) => ({
            name: name(p.id),
            [p.kind]: { displayName: p.display, ...(p.user ? { user: p.user } : {}) },
          })),
        });
      }
      const p = people.find((p) => path === `/v2/${name(p.id)}/participantSessions`);
      if (p) {
        return jsonResponse({
          participantSessions: [
            {
              name: `${name(p.id)}/participantSessions/s${p.start}`,
              startTime: time(p.start),
              endTime: time(p.start + p.minutes),
            },
          ],
        });
      }
      return new Response(`unexpected ${path}`, { status: 404 });
    }),
  );
}
describe("Google Meet attendance identity", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [
      "two anonymous participants sharing a display name",
      [person("a1", "anonymousUser", "Alex", 1, 10), person("a2", "anonymousUser", "Alex", 20, 15)],
      [
        ["a1", 10],
        ["a2", 15],
      ],
    ],
    [
      "two phone participants sharing a display name",
      [person("p1", "phoneUser", "Caller", 2, 8), person("p2", "phoneUser", "Caller", 30, 12)],
      [
        ["p1", 8],
        ["p2", 12],
      ],
    ],
    [
      "anonymous and phone participants sharing a display name",
      [person("a1", "anonymousUser", "Guest", 3, 7), person("p1", "phoneUser", "Guest", 25, 11)],
      [
        ["a1", 7],
        ["p1", 11],
      ],
    ],
    [
      "case-equivalent anonymous display names",
      [person("a1", "anonymousUser", "ALEX", 4, 6), person("a2", "anonymousUser", "alex", 22, 9)],
      [
        ["a1", 6],
        ["a2", 9],
      ],
    ],
    [
      "unnamed anonymous participants",
      [
        person("a1", "anonymousUser", undefined, 5, 5),
        person("a2", "anonymousUser", undefined, 28, 13),
      ],
      [
        ["a1", 5],
        ["a2", 13],
      ],
    ],
    [
      "signed-in entries without verified user IDs",
      [
        person("s1", "signedinUser", "Taylor", 6, 14),
        person("s2", "signedinUser", "Taylor", 35, 4),
      ],
      [
        ["s1", 14],
        ["s2", 4],
      ],
    ],
    [
      "repeated verified signed-in user ID",
      [
        person("s1", "signedinUser", "Taylor", 7, 10, "users/taylor"),
        person("s2", "signedinUser", "Taylor", 25, 15, "users/taylor"),
      ],
      [["s1,s2", 25]],
    ],
    [
      "distinct verified users sharing a display name",
      [
        person("s1", "signedinUser", "Sam", 8, 16, "users/one"),
        person("s2", "signedinUser", "Sam", 32, 6, "users/two"),
      ],
      [
        ["s1", 16],
        ["s2", 6],
      ],
    ],
    [
      "duplicate rows for one participant resource",
      [person("a1", "anonymousUser", "Alex", 9, 3), person("a1", "anonymousUser", "Alex", 15, 4)],
      [["a1", 6]],
    ],
    [
      "explicit merge opt-out for one verified user",
      [
        person("s1", "signedinUser", "Taylor", 10, 8, "users/taylor"),
        person("s2", "signedinUser", "Taylor", 30, 10, "users/taylor"),
      ],
      [
        ["s1", 8],
        ["s2", 10],
      ],
      false,
    ],
  ] as const)("%s", async (_label, people, expected, merge = true) => {
    stubApi(people);
    const result = await fetchGoogleMeetAttendance({
      accessToken: "test-token",
      conferenceRecord: "rec-1",
      ...(merge ? {} : { mergeDuplicateParticipants: false }),
    });
    expect(
      result.attendance.map((row) => [
        row.participants?.map((value) => value.split("/").at(-1)).join(","),
        (row.durationMs ?? 0) / 60_000,
      ]),
    ).toEqual(expected);
  });
});
