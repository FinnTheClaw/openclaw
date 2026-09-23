import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { meetStatusScript } from "./google-meet-page-scripts.js";

type Case = {
  id: string;
  readOnly?: boolean;
  allowMicrophone?: boolean;
  choice?: boolean;
  noMicChoice?: boolean;
  delayedChoice?: boolean;
  duplicateChoice?: boolean;
  throwOnClick?: boolean;
  expectClicked?: boolean;
  expectManual?: boolean;
  expectReject?: boolean;
};

async function runCase(testCase: Case) {
  const microphone = {
    disabled: false,
    textContent: "Use microphone",
    getAttribute: (name: string) => (name === "aria-label" ? "Use microphone" : null),
    click: vi.fn(() => {
      if (testCase.throwOnClick) {
        throw new Error("click rejected");
      }
    }),
  };
  const secondMicrophone = {
    ...microphone,
    click: vi.fn(),
  };
  const noMicrophone = {
    disabled: false,
    textContent: "Continue without microphone",
    getAttribute: (name: string) => (name === "aria-label" ? "Continue without microphone" : null),
    click: vi.fn(),
  };
  let buttonQueries = 0;
  const document = {
    body: { textContent: "Do you want people to hear you in the meeting?" },
    title: "Meet choice",
    querySelector: () => null,
    querySelectorAll(selector: string) {
      if (selector === "button") {
        buttonQueries += 1;
        const ready = !testCase.delayedChoice || buttonQueries > 1;
        return ready
          ? [
              ...(testCase.choice ? [microphone] : []),
              ...(testCase.duplicateChoice ? [secondMicrophone] : []),
              ...(testCase.noMicChoice ? [noMicrophone] : []),
            ]
          : [];
      }
      return [];
    },
  };
  const evaluate = async () =>
    JSON.parse(
      (await runInNewContext(
        `(${meetStatusScript({
          allowMicrophone: testCase.allowMicrophone ?? true,
          autoJoin: false,
          captureCaptions: false,
          guestName: "Agent",
          readOnly: testCase.readOnly,
        })})()`,
        {
          document,
          location: { href: "https://meet.google.com/abc-defg-hij", hostname: "meet.google.com" },
          navigator: { mediaDevices: { enumerateDevices: async () => [] } },
          setTimeout: (callback: () => void) => {
            callback();
            return 1;
          },
          clearTimeout,
          window: {},
          Event: globalThis.Event,
        },
      )) as string,
    ) as Record<string, unknown>;
  return { evaluate, microphone, secondMicrophone, noMicrophone };
}

describe("CH10 Meet microphone choice reports actual click", () => {
  it.each([
    {
      id: "P01 readOnly visible prompt",
      readOnly: true,
      choice: true,
      expectClicked: false,
      expectManual: true,
    },
    { id: "P02 writable visible prompt", choice: true, expectClicked: true },
    { id: "P03 writable absent prompt", expectClicked: false, expectManual: true },
    { id: "P04 readOnly absent prompt", readOnly: true, expectClicked: false, expectManual: true },
    {
      id: "P05 no-microphone choice",
      allowMicrophone: false,
      noMicChoice: true,
      expectClicked: false,
    },
    { id: "P06 click throws", choice: true, throwOnClick: true, expectReject: true },
    { id: "P07 delayed prompt", choice: true, delayedChoice: true, expectClicked: true },
    {
      id: "P08 duplicate controls click one",
      choice: true,
      duplicateChoice: true,
      expectClicked: true,
    },
    {
      id: "P09 readOnly no-mic manual action",
      readOnly: true,
      allowMicrophone: false,
      noMicChoice: true,
      expectClicked: false,
      expectManual: true,
    },
    { id: "P10 unrelated fields unchanged", choice: true, expectClicked: true },
  ] as Case[])("$id", async (testCase) => {
    const { evaluate, microphone, secondMicrophone, noMicrophone } = await runCase(testCase);
    if (testCase.expectReject) {
      await expect(evaluate()).rejects.toThrow("click rejected");
      return;
    }
    const status = await evaluate();
    expect(status.clickedMicrophoneChoice).toBe(testCase.expectClicked);
    expect(microphone.click).toHaveBeenCalledTimes(testCase.expectClicked ? 1 : 0);
    expect(secondMicrophone.click).not.toHaveBeenCalled();
    if (testCase.allowMicrophone === false && testCase.noMicChoice) {
      expect(noMicrophone.click).toHaveBeenCalledTimes(testCase.readOnly ? 0 : 1);
    }
    if (testCase.expectManual) {
      expect(status.manualAction).toMatchObject({ reason: "meet-audio-choice-required" });
      if (testCase.id.startsWith("P09")) {
        expect(JSON.stringify(status.manualAction)).toContain("no-microphone");
      }
    }
    if (testCase.id.startsWith("P10")) {
      expect(status.title).toBe("Meet choice");
      expect(status.url).toBe("https://meet.google.com/abc-defg-hij");
    }
  });
});
