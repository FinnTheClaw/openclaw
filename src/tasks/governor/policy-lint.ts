// Rejects rule text that can suppress needed tools or turn activity counts into goals.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
export type GovernorPolicyViolation = {
  ruleIndex: number;
  code:
    | "never_use_tools"
    | "always_use_tools"
    | "minimum_tool_calls"
    | "one_tool_per_turn"
    | "stop_after_one_turn"
    | "invalid_policy_version"
    | "invalid_policy_digest"
    | "tool_semantics_not_proportional"
    | "continuation_semantics_unsafe"
    | "tool_count_semantics_unsafe"
    | "memory_semantics_unsafe"
    | "effectful_semantics_unsafe";
  excerpt: string;
};

export type GovernorPolicyBundle = Readonly<{
  version: number;
  digest: string;
  rules: readonly string[];
  semantics: Readonly<{
    toolUse: string;
    continuation: string;
    toolCounts: string;
    memoryAuthority: string;
    effectfulWork: string;
  }>;
}>;

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

export function lintGovernorPolicyBundle(bundle: GovernorPolicyBundle): GovernorPolicyViolation[] {
  const violations = lintGovernorPolicy(bundle.rules);
  const structural: Array<{
    valid: boolean;
    code: GovernorPolicyViolation["code"];
    excerpt: string;
  }> = [
    { valid: bundle.version === 1, code: "invalid_policy_version", excerpt: "policy-version" },
    {
      valid: bundle.semantics.toolUse === "proportional",
      code: "tool_semantics_not_proportional",
      excerpt: "tool-use-semantics",
    },
    {
      valid: bundle.semantics.continuation === "until_deterministic_finish_or_blocker",
      code: "continuation_semantics_unsafe",
      excerpt: "continuation-semantics",
    },
    {
      valid: bundle.semantics.toolCounts === "never_targets",
      code: "tool_count_semantics_unsafe",
      excerpt: "tool-count-semantics",
    },
    {
      valid: bundle.semantics.memoryAuthority === "fresh_admitted_evidence_over_memory",
      code: "memory_semantics_unsafe",
      excerpt: "memory-authority-semantics",
    },
    {
      valid: bundle.semantics.effectfulWork === "contract_plan_execute_verify",
      code: "effectful_semantics_unsafe",
      excerpt: "effectful-work-semantics",
    },
  ];
  for (const item of structural) {
    if (!item.valid) {
      violations.push({ ruleIndex: -1, code: item.code, excerpt: item.excerpt });
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

export function assertSafeGovernorPolicyBundle(bundle: GovernorPolicyBundle): void {
  const violations = lintGovernorPolicyBundle(bundle);
  if (violations.length > 0) {
    throw new Error(
      `Unsafe governor policy: ${violations.map((item) => `${item.code}@${item.ruleIndex}`).join(", ")}`,
    );
  }
  const expectedDigest = governorDigest({
    version: bundle.version,
    semantics: bundle.semantics,
    rules: bundle.rules,
  } as unknown as GovernorJsonValue);
  if (bundle.digest !== expectedDigest) {
    throw new Error("Unsafe governor policy: invalid_policy_digest@-1");
  }
}
