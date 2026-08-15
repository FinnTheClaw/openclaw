const TRIVIAL_PATTERNS = [
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[!. ]*$/iu,
  /^(?:ok(?:ay)?|sure|got it|sounds good|understood|noted)[!. ]*$/iu,
  /^(?:thanks|thank you|thx|ty)(?: very much)?[!. ]*$/iu,
  /^(?:bye|goodbye|see you|talk later)[!. ]*$/iu,
  /^(?:👍|👌|✅|🙏|❤️|❤)+$/u,
  /^(?:how are you|how's it going|what's up)[?.! ]*$/iu,
] as const;

export type FunctionalFinnRequestClass = "trivial" | "substantive";

export function classifyFunctionalFinnRequest(prompt: string): FunctionalFinnRequestClass {
  const normalized = prompt.trim().replace(/\s+/gu, " ");
  if (!normalized) {
    return "trivial";
  }
  return TRIVIAL_PATTERNS.some((pattern) => pattern.test(normalized)) ? "trivial" : "substantive";
}
