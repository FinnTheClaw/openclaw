import { Type } from "typebox";
import { expect, it } from "vitest";
import {
  projectOpenAITools,
  reconcileOpenAICompletionsToolChoice,
  reconcileOpenAIResponsesToolChoice,
} from "./openai-tool-projection.js";
import { findOpenAIStrictToolProjectionDiagnostics } from "./openai-tool-schema.js";

const lookup = projectOpenAITools([{ name: "lookup", parameters: {} }]);
const responseFunction = (name: string) => ({ type: "function" as const, name });
const completionFunction = (name: string) => ({ type: "function" as const, function: { name } });
const custom = { type: "custom" as const, custom: { name: "shell" } };
const webSearch = { type: "web_search_preview" as const };
function allowedResponses(tools: Array<ReturnType<typeof responseFunction> | typeof webSearch>) {
  return { type: "allowed_tools" as const, mode: "required" as const, tools };
}
function allowedCompletions(
  mode: "auto" | "required",
  tools: Array<ReturnType<typeof completionFunction> | typeof custom>,
) {
  return { type: "allowed_tools" as const, allowed_tools: { mode, tools } };
}
function unreadable<T extends object>(field: string, value: T): T {
  return Object.defineProperty(value, field, {
    enumerable: true,
    get() {
      throw new Error(`${field} exploded`);
    },
  });
}

it("keeps healthy tools when sibling descriptors or schemas are unreadable", () => {
  const projection = projectOpenAITools([
    unreadable("name", { parameters: {} }),
    {
      name: "bad_schema",
      parameters: unreadable("properties", { type: "object" }),
    },
    unreadable("description", { name: "lookup", parameters: undefined }),
  ]);

  expect(projection.tools).toEqual([{ toolIndex: 2, name: "lookup", parameters: {} }]);
  expect(findOpenAIStrictToolProjectionDiagnostics(projection)).toEqual([
    { toolIndex: 0, violations: ["tool[0].name is unreadable"] },
    {
      toolIndex: 1,
      toolName: "bad_schema",
      violations: ["bad_schema.parameters is not JSON-serializable"],
    },
  ]);
});

it.each(["responses", "completions"])("materializes %s choices after one name read", (api) => {
  let reads = 0;
  const choice = {
    type: "function" as const,
    get name() {
      return ++reads === 1 ? "lookup" : "broken";
    },
  };
  const projected =
    api === "responses"
      ? reconcileOpenAIResponsesToolChoice(choice, lookup)
      : reconcileOpenAICompletionsToolChoice({ type: "function", function: choice }, lookup);
  expect({ projected, reads }).toEqual({
    projected: api === "responses" ? responseFunction("lookup") : completionFunction("lookup"),
    reads: 1,
  });
});

it("keeps literal reference examples while quarantining dynamic schema references", () => {
  const parameters = Type.Object(
    { document: Type.Record(Type.String(), Type.Unknown()) },
    { examples: [{ document: { $dynamicAnchor: "node", $dynamicRef: "#node" } }] },
  );
  const projection = projectOpenAITools([
    { name: "store_schema", parameters },
    {
      name: "dynamic",
      parameters: {
        type: "object",
        properties: { value: { $dynamicRef: "#value" } },
      },
    },
  ]);

  expect(projection.tools).toEqual([{ toolIndex: 0, name: "store_schema", parameters }]);
  expect(projection.diagnostics).toEqual([
    {
      toolIndex: 1,
      toolName: "dynamic",
      violations: ["dynamic.parameters.properties.value.$dynamicRef"],
    },
  ]);
});

it("classifies sparse descriptors as unreadable tools", () => {
  const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  tools.length = 1;
  expect(projectOpenAITools(tools)).toEqual({
    inputToolCount: 1,
    tools: [],
    diagnostics: [{ toolIndex: 0, violations: ["tool[0] is unreadable"] }],
  });
});

it("rejects pinned and required choices when their function tools are unavailable", () => {
  const projection = projectOpenAITools([
    unreadable("parameters", { name: "broken", parameters: {} }),
  ]);

  expect(() => reconcileOpenAIResponsesToolChoice(responseFunction("broken"), projection)).toThrow(
    'requested unavailable tool "broken"',
  );
  expect(() =>
    reconcileOpenAICompletionsToolChoice(completionFunction("broken"), projection),
  ).toThrow('requested unavailable tool "broken"');
  for (const reconcile of [
    reconcileOpenAIResponsesToolChoice,
    reconcileOpenAICompletionsToolChoice,
  ]) {
    expect(() => reconcile("required", projection)).toThrow("no tools survived schema conversion");
  }
});

it("filters official Responses allowed_tools without broadening access", () => {
  expect(
    reconcileOpenAIResponsesToolChoice(
      allowedResponses([responseFunction("broken"), responseFunction("lookup"), webSearch]),
      lookup,
    ),
  ).toEqual(allowedResponses([responseFunction("lookup"), webSearch]));
});

it("filters official Chat Completions allowed_tools without broadening access", () => {
  expect(
    reconcileOpenAICompletionsToolChoice(
      allowedCompletions("required", [
        completionFunction("broken"),
        completionFunction("lookup"),
        custom,
      ]),
      lookup,
    ),
  ).toEqual(allowedCompletions("required", [completionFunction("lookup")]));
});

it("rejects unsupported top-level Chat Completions custom choices", () => {
  expect(() => reconcileOpenAICompletionsToolChoice(custom, lookup)).toThrow(
    "custom tool_choice is unsupported",
  );
});

it("disables an auto Chat Completions allowed_tools choice when none survive", () => {
  expect(
    reconcileOpenAICompletionsToolChoice(
      allowedCompletions("auto", [completionFunction("broken"), custom]),
      lookup,
    ),
  ).toBe("none");
});

it("preserves non-function Responses choices", () => {
  expect(reconcileOpenAIResponsesToolChoice(webSearch, projectOpenAITools([]))).toEqual(webSearch);
});

it.each([
  ["default", "literal"],
  ["const", "literal"],
  ["enum", "literal"],
  ["examples", "literal"],
  ["$dynamicRef", "schema"],
  ["$dynamicAnchor", "schema"],
  ["default", "nonfinite"],
] as const)("literal schema data: %s %s", (keyword, kind) => {
  const literal = {
    $dynamicRef: "ordinary-data",
    $dynamicAnchor: "ordinary-anchor",
    nested: { properties: { named: { $dynamicRef: "still-literal" } } },
  };
  const payload =
    kind === "literal"
      ? {
          type: "object",
          [keyword]: keyword === "enum" || keyword === "examples" ? [literal] : literal,
        }
      : kind === "schema"
        ? { [keyword]: "#actual" }
        : { type: "object", default: { value: Number.POSITIVE_INFINITY } };
  const parameters = { type: "object", properties: { payload } };
  const siblingParameters = { type: "object", properties: {} };
  const input = [
    { name: "custom", parameters },
    { name: "healthy", parameters: siblingParameters },
  ];
  const before = structuredClone(input);

  const projection = projectOpenAITools(input);

  expect(projection.inputToolCount).toBe(2);
  expect(projection.tools).toEqual([
    ...(kind === "literal" ? [{ toolIndex: 0, name: "custom", parameters }] : []),
    { toolIndex: 1, name: "healthy", parameters: siblingParameters },
  ]);
  expect(projection.diagnostics).toEqual(
    kind === "literal"
      ? []
      : [
          {
            toolIndex: 0,
            toolName: "custom",
            violations: [
              kind === "schema"
                ? "custom.parameters.properties.payload." + keyword
                : "custom.parameters.properties.payload.default.value is not JSON-serializable",
            ],
          },
        ],
  );
  const responsesChoice = { type: "function" as const, name: "custom" };
  const completionsChoice = { type: "function" as const, function: { name: "custom" } };
  if (kind === "literal") {
    expect(reconcileOpenAIResponsesToolChoice(responsesChoice, projection)).toEqual(
      responsesChoice,
    );
    expect(reconcileOpenAICompletionsToolChoice(completionsChoice, projection)).toEqual(
      completionsChoice,
    );
    expect(projection.tools[0]?.parameters).not.toBe(parameters);
  } else {
    expect(() => reconcileOpenAIResponsesToolChoice(responsesChoice, projection)).toThrow(
      'requested unavailable tool "custom"',
    );
    expect(() => reconcileOpenAICompletionsToolChoice(completionsChoice, projection)).toThrow(
      'requested unavailable tool "custom"',
    );
  }
  expect(input).toEqual(before);
});
