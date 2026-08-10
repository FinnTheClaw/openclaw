// Rejects rule text that can suppress needed tools or turn activity counts into goals.
export type GovernorPolicyViolation = {
  ruleIndex: number;
  code:
    | "never_use_tools"
    | "always_use_tools"
    | "minimum_tool_calls"
    | "one_tool_per_turn"
    | "stop_after_one_turn";
  excerpt: string;
};

const DANGEROUS_POLICY_PATTERNS: ReadonlyArray<{
  code: GovernorPolicyViolation["code"];
  pattern: RegExp;
}> = [
  {
    code: "never_use_tools",
    pattern: /\bnever\s+(?:call|invoke|run|use)\s+(?:a\s+|any\s+|the\s+)?tools?\b/i,
  },
  {
    code: "always_use_tools",
    pattern: /\balways\s+(?:call|invoke|run|use)\s+(?:a\s+|any\s+|the\s+)?tools?\b/i,
  },
  {
    code: "minimum_tool_calls",
    pattern: /\b(?:minimum(?:\s+of)?|at\s+least)\s+\d+\s+(?:tool\s+)?calls?\b/i,
  },
  {
    code: "one_tool_per_turn",
    pattern: /\b(?:exactly\s+)?one\s+tool(?:\s+call)?\s+per\s+turn\b/i,
  },
  {
    code: "stop_after_one_turn",
    pattern: /\bstop\s+after\s+(?:one|1)\s+turn\b/i,
  },
];

export function lintGovernorPolicy(rules: readonly string[]): GovernorPolicyViolation[] {
  const violations: GovernorPolicyViolation[] = [];
  for (const [ruleIndex, rule] of rules.entries()) {
    for (const candidate of DANGEROUS_POLICY_PATTERNS) {
      const match = candidate.pattern.exec(rule);
      if (match) {
        violations.push({
          ruleIndex,
          code: candidate.code,
          excerpt: match[0],
        });
      }
    }
  }
  return violations;
}

export function assertSafeGovernorPolicy(rules: readonly string[]): void {
  const violations = lintGovernorPolicy(rules);
  if (violations.length > 0) {
    throw new Error(
      `Unsafe governor policy: ${violations.map((item) => `${item.code}@${item.ruleIndex}`).join(", ")}`,
    );
  }
}
