/** Shared shape for the security-owned durable boundary inventory. */
export type GovernorDurableBoundary = Readonly<{
  id: string;
  file: `src/${string}.ts`;
  symbol: string;
  direction: "read" | "write" | "read-write";
  enforcementAnchors: readonly [string, ...string[]];
}>;

export function governorDurableBoundary(
  id: string,
  file: GovernorDurableBoundary["file"],
  symbol: string,
  direction: GovernorDurableBoundary["direction"],
  enforcementAnchors: GovernorDurableBoundary["enforcementAnchors"],
): GovernorDurableBoundary {
  return { id, file, symbol, direction, enforcementAnchors };
}
