import { describe, expect, it } from "vitest";
import { isBotMentioned, stripBotMention } from "./utils.js";

const ship = "~sampel-palnet";
const cases = [
  ["P01 lowercase", "hey ~sampel-palnet", "hey", true],
  ["P02 uppercase", "hey ~SAMPEL-PALNET", "hey", true],
  ["P03 mixed-case", "hey ~Sampel-Palnet now", "hey  now", true],
  ["P04 start boundary", "~SAMPEL-PALNET help", "help", true],
  ["P05 whitespace boundary", "hey\t~SAMPEL-PALNET\nhelp", "hey\t\nhelp", true],
  ["P06 embedded unrelated word", "my~SAMPEL-PALNETfriend", "my~SAMPEL-PALNETfriend", false],
  [
    "P07 punctuation consistent with detection",
    "~SAMPEL-PALNET, help",
    "~SAMPEL-PALNET, help",
    false,
  ],
  ["P08 regex-special ship escaped", "hey ~SAMP.EL", "hey", true, "~samp.el"],
  ["P09 absent mention unchanged", "hello world", "hello world", false],
  [
    "P10 repeated mentions one-strip contract",
    "~Sampel-Palnet and ~SAMPEL-PALNET",
    "and ~SAMPEL-PALNET",
    true,
  ],
] as const;

describe("CH05 Tlon ship mention stripping", () => {
  it.each(cases)("%s", (_name, input, output, detected, configuredShip) => {
    expect(isBotMentioned(input, configuredShip ?? ship)).toBe(detected);
    expect(stripBotMention(input, configuredShip ?? ship)).toBe(output);
  });
});
