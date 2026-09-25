// Focused argv preservation contract for the production ACPX command splitter.
import { describe, expect, it } from "vitest";
import { splitCommandParts } from "./command-line.js";

describe("splitCommandParts explicit empty argv", () => {
  it("F10-01 keeps a middle double-quoted empty argument", () => {
    expect(splitCommandParts('cmd "" tail')).toEqual(["cmd", "", "tail"]);
  });

  it("F10-02 keeps a middle single-quoted empty argument", () => {
    expect(splitCommandParts("cmd '' tail")).toEqual(["cmd", "", "tail"]);
  });

  it("F10-03 keeps a trailing double-quoted empty argument", () => {
    expect(splitCommandParts('cmd ""')).toEqual(["cmd", ""]);
  });

  it("F10-04 keeps a leading double-quoted empty argument", () => {
    expect(splitCommandParts('"" cmd')).toEqual(["", "cmd"]);
  });

  it("F10-05 keeps consecutive empty arguments", () => {
    expect(splitCommandParts('cmd "" "" tail')).toEqual(["cmd", "", "", "tail"]);
  });

  it("F10-06 joins adjacent quoted and unquoted fragments", () => {
    expect(splitCommandParts('cmd a""b')).toEqual(["cmd", "ab"]);
  });

  it("F10-07 preserves quoted spaces", () => {
    expect(splitCommandParts('cmd "a b" tail')).toEqual(["cmd", "a b", "tail"]);
  });

  it("F10-08 preserves an escaped space", () => {
    expect(splitCommandParts("cmd a\\ b")).toEqual(["cmd", "a b"]);
  });

  it("F10-09 ignores whitespace without manufacturing tokens", () => {
    expect(splitCommandParts(" \t  \n ")).toEqual([]);
  });
});
