/* @vitest-environment jsdom */
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeFileMatches } from "./chat-sidebar-file-view.ts";

describe("UI-CHAT-01", () => {
  it.each([
    { id: "01 CR repeated", content: "alpha\rbeta\rbeta", query: "beta", expected: [2, 3] },
    { id: "02 LF control", content: "alpha\nbeta\nbeta", query: "beta", expected: [2, 3] },
    { id: "03 CRLF control", content: "alpha\r\nbeta\r\nbeta", query: "beta", expected: [2, 3] },
    { id: "04 CR leading blank", content: "\rbeta", query: "beta", expected: [2] },
    { id: "05 CR trailing blank", content: "alpha\rbeta\r", query: "beta", expected: [2] },
    { id: "06 CR consecutive blanks", content: "alpha\r\rBETA", query: "beta", expected: [3] },
    { id: "07 CR no match", content: "alpha\rbeta", query: "gamma", expected: [] },
    { id: "08 CR empty query", content: "alpha\rbeta", query: "", expected: [] },
    { id: "09 single line control", content: "beta beta", query: "beta", expected: [1] },
    {
      id: "10 CR multiple occurrences",
      content: "beta beta\ralpha\rbeta",
      query: "beta",
      expected: [1, 3],
    },
  ])("$id", ({ content, query, expected }) => {
    const matches = computeFileMatches(content, query);
    expect(matches).toEqual(expected);
    const separator = content.match(/\r\n|\r|\n/)?.[0];
    const state = EditorState.create({
      doc: content,
      extensions: separator && separator !== "\n" ? [EditorState.lineSeparator.of(separator)] : [],
    });
    for (const line of matches) {
      expect(state.doc.line(line).text.toLocaleLowerCase()).toContain(query.toLocaleLowerCase());
    }
  });
});
