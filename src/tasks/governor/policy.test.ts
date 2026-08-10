// Proves proportional quick/deep behavior and rejects dangerous prompt absolutes.
import { describe, expect, it } from "vitest";
import { governorDigest } from "./canonical-json.js";
import { classifyGovernorWork, createGovernorCheckpoint } from "./planning-policy.js";
import { assertSafeGovernorPolicy, lintGovernorPolicy } from "./policy-lint.js";
import {
  GOVERNOR_AGENT_RULES,
  GOVERNOR_POLICY_INTERPRETATION,
  GOVERNOR_SOUL_POLICY,
} from "./policy.js";
import { createGovernorTaskProjection, type GovernorTaskContract } from "./types.js";

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

  it("keeps the exact thin policy safe and rejects dangerous absolutes", () => {
    expect(GOVERNOR_SOUL_POLICY).toContain("Handle simple work simply.");
    expect(GOVERNOR_POLICY_INTERPRETATION).toContain("Tool counts are never targets.");
    expect(() =>
      assertSafeGovernorPolicy([
        GOVERNOR_SOUL_POLICY,
        GOVERNOR_POLICY_INTERPRETATION,
        ...GOVERNOR_AGENT_RULES,
      ]),
    ).not.toThrow();
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
    });
    const checkpoint = createGovernorCheckpoint({
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
