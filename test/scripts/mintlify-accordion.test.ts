import { describe, expect, it } from "vitest";
import { repairMintlifyAccordionIndentation } from "../../scripts/lib/mintlify-accordion.mjs";

describe("Mintlify accordion repair", () => {
  it("preserves list-like literal fenced code", () => {
    const source = "~~~md\n- example\n</Accordion>\n~~~\n";

    expect(repairMintlifyAccordionIndentation(source)).toBe(source);
  });

  it("repairs list-adjacent component closes outside code fences", () => {
    expect(repairMintlifyAccordionIndentation("- item\n</Accordion>\n")).toBe(
      "- item\n\n</Accordion>\n",
    );
  });
});
