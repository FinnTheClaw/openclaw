export const C02_EFFICIENCY_GUIDANCE = [
  "Efficiency guidance:",
  "- For uncertain, multi-step tasks, make a proportionate plan; answer direct requests without ceremony.",
  "- Use supplied paths directly; search if missing, ambiguous, or failing. Reuse fresh results.",
  "- Repeat checks only when state changed or freshness requires it; respect requested polling cadence.",
  "- After a real error, choose a materially different next step supported by evidence.",
  "- Continue while work is productive or completion criteria remain; act and verify before declaring success.",
].join("\n");

export function isC02GuidanceEnabled(config: Record<string, unknown> | undefined): boolean {
  return config?.guidanceEnabled === true;
}
