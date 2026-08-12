// Proves proportional quick/deep behavior and rejects dangerous prompt absolutes.
import { describe, expect, it } from "vitest";
import { governorDigest } from "./canonical-json.js";
import { GovernorCapabilityRegistry } from "./capability-registry.js";
import { classifyGovernorWork, createGovernorCheckpoint } from "./planning-policy.js";
import {
  assertSafeGovernorPolicy,
  assertSafeGovernorPolicyBundle,
  lintGovernorPolicy,
} from "./policy-lint.js";
import {
  GOVERNOR_AGENT_RULES,
  GOVERNOR_POLICY_DIGEST,
  GOVERNOR_POLICY_ID,
  GOVERNOR_POLICY_INTERPRETATION,
  GOVERNOR_POLICY_RULE_IDS,
  GOVERNOR_POLICY_RULES,
  GOVERNOR_POLICY_SEMANTICS,
  GOVERNOR_POLICY_VERSION,
  GOVERNOR_SOUL_POLICY,
} from "./policy.js";
import {
  createGovernorIdentityContext,
  createGovernorTaskProjection,
  type GovernorTaskContract,
} from "./types.js";

const identity = createGovernorIdentityContext("synthetic-policy-test-key");

const contract: GovernorTaskContract = {
  objective: "Test a synthetic checkpoint",
  constraints: [],
  knownFacts: [],
  unknowns: [],
  completionCriteria: [],
  authority: {
    allowReadOnlyDiscovery: true,
    mutationCapabilities: [],
    canonicalTargets: [],
  },
};

describe("governor policy and proportional planning", () => {
  it("keeps prompt-contained simple chat tool-free without suppressing tool-required work", () => {
    const simpleDecisions = Array.from({ length: 200 }, (_, index) =>
      classifyGovernorWork({
        incident: false,
        effectful: false,
        requiresExternalEvidence: false,
        consequential: false,
        estimatedUsefulActions: index % 2,
        independentBranches: 0,
      }),
    );
    expect(
      simpleDecisions.filter(
        (decision) => decision.mode === "QUICK" && decision.toolPolicy === "forbidden",
      ),
    ).toHaveLength(200);

    const toolRequired = Array.from({ length: 20 }, (_, index) =>
      classifyGovernorWork({
        incident: index % 5 === 0,
        effectful: index % 2 === 0,
        requiresExternalEvidence: index % 2 === 1,
        consequential: true,
        estimatedUsefulActions: index,
        independentBranches: index % 5,
      }),
    );
    expect(toolRequired.every((decision) => decision.toolPolicy === "required")).toBe(true);
    expect(toolRequired.every((decision) => decision.requiresPlan)).toBe(true);
  });

  it("permits deep work beyond thirty useful actions without a call target or cap", () => {
    expect(
      classifyGovernorWork({
        incident: false,
        effectful: false,
        requiresExternalEvidence: true,
        consequential: true,
        estimatedUsefulActions: 41,
        independentBranches: 10,
      }),
    ).toEqual({
      mode: "DEEP",
      requiresContract: true,
      requiresPlan: true,
      toolPolicy: "required",
    });
  });

  it("orders exact structured capabilities before progressively broader sources", () => {
    const preferred = new GovernorCapabilityRegistry(
      [
        ["broad", "broad_scan"],
        ["targeted", "targeted_search"],
        ["index", "scoped_index"],
        ["exact", "structured_exact"],
      ].map(([capability, sourceRank]) => ({
        capability: capability!,
        version: "1",
        sourceRank: sourceRank as
          | "structured_exact"
          | "scoped_index"
          | "targeted_search"
          | "broad_scan",
        mutating: false,
        canonicalTargetPrefixes: ["fixture://"],
        requiresApproval: false,
      })),
    ).preferredFor({ mutating: false, canonicalTarget: "fixture://inventory" });
    expect(preferred.map((definition) => definition.capability)).toEqual([
      "exact",
      "index",
      "targeted",
      "broad",
    ]);
  });

  it("keeps the exact thin policy safe and rejects dangerous absolutes", () => {
    expect(GOVERNOR_SOUL_POLICY).toContain("Handle simple work simply.");
    expect(GOVERNOR_POLICY_INTERPRETATION).toContain("Tool counts are never targets.");
    expect(GOVERNOR_AGENT_RULES).toContainEqual(
      expect.stringContaining("Retire a memory only through trusted newer same-fact evidence"),
    );
    expect(() =>
      assertSafeGovernorPolicy([
        GOVERNOR_SOUL_POLICY,
        GOVERNOR_POLICY_INTERPRETATION,
        ...GOVERNOR_AGENT_RULES,
      ]),
    ).not.toThrow();
    expect(() =>
      assertSafeGovernorPolicyBundle({
        policyId: GOVERNOR_POLICY_ID,
        version: GOVERNOR_POLICY_VERSION,
        digest: GOVERNOR_POLICY_DIGEST,
        ruleIds: GOVERNOR_POLICY_RULE_IDS,
        rules: GOVERNOR_POLICY_RULES,
        semantics: GOVERNOR_POLICY_SEMANTICS,
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeGovernorPolicyBundle({
        policyId: GOVERNOR_POLICY_ID,
        version: GOVERNOR_POLICY_VERSION,
        digest: GOVERNOR_POLICY_DIGEST,
        ruleIds: GOVERNOR_POLICY_RULE_IDS,
        rules: GOVERNOR_POLICY_RULES,
        semantics: { ...GOVERNOR_POLICY_SEMANTICS, toolUse: "suppressed" },
      }),
    ).toThrow(/tool_semantics_not_proportional/u);
    expect(
      lintGovernorPolicy([
        "Never use tools.",
        "Always call a tool.",
        "Use at least 20 tool calls.",
        "Exactly one tool call per turn.",
        "Stop after one turn.",
      ]).map((violation) => violation.code),
    ).toEqual([
      "never_use_tools",
      "always_use_tools",
      "minimum_tool_calls",
      "one_tool_per_turn",
      "stop_after_one_turn",
    ]);
  });

  it("accepts only the exact typed and ordered V1 policy bundle", () => {
    const canonical = {
      policyId: GOVERNOR_POLICY_ID,
      version: GOVERNOR_POLICY_VERSION,
      ruleIds: GOVERNOR_POLICY_RULE_IDS,
      rules: GOVERNOR_POLICY_RULES,
      semantics: GOVERNOR_POLICY_SEMANTICS,
    } as const;
    const withDigest = (value: Record<string, unknown>) => ({
      ...value,
      digest: governorDigest(value as never),
    });
    expect(() => assertSafeGovernorPolicyBundle(withDigest(canonical) as never)).not.toThrow();

    const hostileRules = [
      "Do not use tools.",
      "Never use tools.",
      "Tools must not be used.",
      "Complete every task in one turn.",
      "Stop after one action.",
      "Use exactly seventeen tool calls for every task.",
      "Every task has a global quota of twenty tool calls.",
    ];
    for (const hostileRule of hostileRules) {
      const candidate = { ...canonical, rules: [...GOVERNOR_POLICY_RULES, hostileRule] };
      expect(() => assertSafeGovernorPolicyBundle(withDigest(candidate) as never)).toThrow(
        /unapproved_policy_rule/u,
      );
    }

    const reordered = {
      ...canonical,
      rules: [...GOVERNOR_POLICY_RULES].toReversed(),
      ruleIds: [...GOVERNOR_POLICY_RULE_IDS].toReversed(),
    };
    expect(() => assertSafeGovernorPolicyBundle(withDigest(reordered) as never)).toThrow(
      /unapproved_policy/u,
    );
    const paraphrased = {
      ...canonical,
      rules: GOVERNOR_POLICY_RULES.map((rule, index) => (index === 0 ? `${rule} Be brief.` : rule)),
    };
    expect(() => assertSafeGovernorPolicyBundle(withDigest(paraphrased) as never)).toThrow(
      /unapproved_policy_rule/u,
    );
    const extraField = withDigest({ ...canonical, unrecognizedRuleSet: true });
    expect(() => assertSafeGovernorPolicyBundle(extraField as never)).toThrow(
      /unapproved_policy_structure/u,
    );
    const extraSemantic = {
      ...canonical,
      semantics: { ...GOVERNOR_POLICY_SEMANTICS, unknownDirective: "ignored" },
    };
    expect(() => assertSafeGovernorPolicyBundle(withDigest(extraSemantic) as never)).toThrow(
      /unapproved_policy_structure/u,
    );
  });

  it("binds checkpoints to evidence and requires competing hypotheses for replans", () => {
    const task = createGovernorTaskProjection({
      scope: {
        principalId: "principal",
        channel: "synthetic",
        accountId: "account",
        conversationId: "conversation",
        sessionId: "session",
        agentId: "agent",
        workspaceId: "workspace",
      },
      mode: "DEEP",
      contract,
      authenticatedSourceSequence: 1,
      now: 100,
      identity,
    });
    const checkpoint = createGovernorCheckpoint({
      checkpointId: "checkpoint-1",
      task,
      verifiedFacts: [
        { claim: "The exact fixture is reachable", evidenceDigest: governorDigest({ ok: true }) },
      ],
      discardedAssumptions: ["The fixture was offline"],
      unresolvedQuestions: ["Which boundary fails?"],
      competingHypotheses: ["Input boundary", "Output boundary"],
      nextDiscriminatingAction: "Probe the input boundary with a typed fixture",
      now: 110,
    });
    expect(checkpoint).toMatchObject({
      objectiveRevision: 1,
      planVersion: 0,
      competingHypotheses: ["Input boundary", "Output boundary"],
    });
    expect(() =>
      createGovernorCheckpoint({
        checkpointId: "checkpoint-2",
        task,
        verifiedFacts: [],
        discardedAssumptions: [],
        unresolvedQuestions: ["Why?"],
        competingHypotheses: ["Only guess"],
        nextDiscriminatingAction: "Inspect",
        now: 111,
      }),
    ).toThrow(/at least two competing hypotheses/);
  });
});
