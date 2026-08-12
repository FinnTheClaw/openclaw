// Rejects rule text that can suppress needed tools or turn activity counts into goals.
import { governorDigest, type GovernorJsonValue } from "./canonical-json.js";
import {
  GOVERNOR_POLICY_DIGEST,
  GOVERNOR_POLICY_ID,
  GOVERNOR_POLICY_RULE_IDS,
  GOVERNOR_POLICY_RULES,
  GOVERNOR_POLICY_SEMANTICS,
  GOVERNOR_POLICY_VERSION,
} from "./policy.js";
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
    | "effectful_semantics_unsafe"
    | "unapproved_policy_structure"
    | "unapproved_policy_rule";
  excerpt: string;
};

export type GovernorPolicyBundle = Readonly<{
  policyId: string;
  version: number;
  digest: string;
  ruleIds: readonly string[];
  rules: readonly string[];
  semantics: Readonly<{
    toolUse: string;
    continuation: string;
    toolCounts: string;
    memoryAuthority: string;
    effectfulWork: string;
  }>;
}>;

const BUNDLE_KEYS = ["digest", "policyId", "ruleIds", "rules", "semantics", "version"] as const;
const SEMANTIC_KEYS = [
  "continuation",
  "effectfulWork",
  "memoryAuthority",
  "toolCounts",
  "toolUse",
] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

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
  const exactStructure =
    hasExactKeys(bundle, BUNDLE_KEYS) &&
    hasExactKeys(bundle.semantics, SEMANTIC_KEYS) &&
    bundle.policyId === GOVERNOR_POLICY_ID &&
    hasExactSequence(bundle.ruleIds, GOVERNOR_POLICY_RULE_IDS);
  if (!exactStructure) {
    violations.push({
      ruleIndex: -1,
      code: "unapproved_policy_structure",
      excerpt: "policy-structure",
    });
  }
  if (!hasExactSequence(bundle.rules, GOVERNOR_POLICY_RULES)) {
    violations.push({
      ruleIndex: -1,
      code: "unapproved_policy_rule",
      excerpt: "policy-rules",
    });
  }
  const structural: Array<{
    valid: boolean;
    code: GovernorPolicyViolation["code"];
    excerpt: string;
  }> = [
    {
      valid: bundle.version === GOVERNOR_POLICY_VERSION,
      code: "invalid_policy_version",
      excerpt: "policy-version",
    },
    {
      valid: bundle.semantics.toolUse === GOVERNOR_POLICY_SEMANTICS.toolUse,
      code: "tool_semantics_not_proportional",
      excerpt: "tool-use-semantics",
    },
    {
      valid: bundle.semantics.continuation === GOVERNOR_POLICY_SEMANTICS.continuation,
      code: "continuation_semantics_unsafe",
      excerpt: "continuation-semantics",
    },
    {
      valid: bundle.semantics.toolCounts === GOVERNOR_POLICY_SEMANTICS.toolCounts,
      code: "tool_count_semantics_unsafe",
      excerpt: "tool-count-semantics",
    },
    {
      valid: bundle.semantics.memoryAuthority === GOVERNOR_POLICY_SEMANTICS.memoryAuthority,
      code: "memory_semantics_unsafe",
      excerpt: "memory-authority-semantics",
    },
    {
      valid: bundle.semantics.effectfulWork === GOVERNOR_POLICY_SEMANTICS.effectfulWork,
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
    policyId: bundle.policyId,
    version: bundle.version,
    ruleIds: bundle.ruleIds,
    semantics: bundle.semantics,
    rules: bundle.rules,
  } as unknown as GovernorJsonValue);
  if (bundle.digest !== expectedDigest || bundle.digest !== GOVERNOR_POLICY_DIGEST) {
    throw new Error("Unsafe governor policy: invalid_policy_digest@-1");
  }
}
