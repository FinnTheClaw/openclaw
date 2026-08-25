// Agent Core tests cover prompt template argument parsing behavior.
import { describe, expect, it } from "vitest";
import { parseCommandArgs, substituteArgs } from "./prompt-template-arguments.js";

describe("prompt template arguments", () => {
  it("preserves quoted empty arguments so positional placeholders stay aligned", () => {
    expect(parseCommandArgs('first "" third')).toEqual(["first", "", "third"]);
    expect(parseCommandArgs("first '' third")).toEqual(["first", "", "third"]);
    expect(substituteArgs("$1|$2|$3", parseCommandArgs('first "" third'))).toBe("first||third");
  });

  it("preserves literal replacement patterns in aggregate arguments", () => {
    const literal = "price $$ and $& and $` and $' here";
    expect(substituteArgs("Args: $ARGUMENTS", [literal])).toBe(`Args: ${literal}`);
    expect(substituteArgs("Args: $@", [literal])).toBe(`Args: ${literal}`);
  });

  it("never re-expands placeholders inserted by positional arguments", () => {
    expect(substituteArgs("$1 $@", ["$ARGUMENTS", "safe"])).toBe("$ARGUMENTS $ARGUMENTS safe");
    expect(substituteArgs("$1 ${@:2:1}", ["$@", "$ARGUMENTS", "safe"])).toBe("$@ $ARGUMENTS");
  });
});
