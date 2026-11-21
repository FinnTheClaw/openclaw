import { expect, it } from "vitest";
import { prefixMatchPath } from "./http-path-prefix.js";

it.each([
  ["/", "/", true],
  ["/assets/logo.svg", "/", true],
  ["relative", "/", false],
  ["/apiary", "/api", false],
  ["/api/resource", "/api", true],
] as const)("prefix %s under %s matches %s", (pathname, prefix, expected) => {
  expect(prefixMatchPath(pathname, prefix)).toBe(expected);
});
