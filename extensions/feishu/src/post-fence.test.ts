import { describe, expect, it } from "vitest";
import { parsePostContent } from "./post.js";

const cases = [
  { name: "ST01-01 plain code", code: "const x = 1;", language: "" },
  { name: "ST01-02 language tag", code: "print(1)", language: "python" },
  { name: "ST01-03 triple run at start", code: "```\ninside", language: "js" },
  { name: "ST01-04 triple run midline", code: "before ``` after", language: "" },
  { name: "ST01-05 quadruple run", code: "````\ninside", language: "text" },
  { name: "ST01-06 longer run", code: "before `````` after", language: "sh" },
  { name: "ST01-07 trailing newline", code: "line\n", language: "" },
  { name: "ST01-08 CRLF normalization", code: "one\r\ntwo", language: "" },
  { name: "ST01-09 following post text", code: "```\ninside", language: "" },
  { name: "ST01-10 empty code", code: "", language: "" },
] as const;

describe("Feishu post code-block fences", () => {
  it.each(cases)("$name", ({ code, language, name }) => {
    const content = JSON.stringify({
      title: "",
      content: [
        [{ tag: "code_block", text: code, language }],
        ...(name.includes("09") ? [[{ tag: "text", text: "After block" }]] : []),
      ],
    });
    const rendered = parsePostContent(content).textContent;
    const normalized = code.replace(/\r\n/g, "\n");
    const maxRun = Math.max(2, ...(normalized.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(maxRun + 1);
    const body = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    const expected = `${fence}${language}\n${body}${fence}`;
    expect(rendered).toBe(name.includes("09") ? `${expected}\nAfter block` : expected);
  });
});
