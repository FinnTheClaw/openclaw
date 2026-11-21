import { randomUUID } from "node:crypto";
import type { WorkboardCard, WorkboardLink } from "@openclaw/workboard-contract";
import { MAX_CARD_LINKS } from "./store-constants.js";

type DependencyLinkType = "parent" | "child";

export function isDependencyLink(link: WorkboardLink): boolean {
  return link.type === "parent" || link.type === "child";
}

function resolveLinkEvictionIndex(links: readonly WorkboardLink[]): number | undefined {
  if (links.length < MAX_CARD_LINKS) {
    return undefined;
  }
  const index = links.findIndex((link) => !isDependencyLink(link));
  if (index < 0) {
    throw new Error("card link limit reached.");
  }
  return index;
}

export function assertWorkboardLinkCapacity(links: readonly WorkboardLink[] = []): void {
  resolveLinkEvictionIndex(links);
}

export function appendLinkPreservingDependencies(
  links: readonly WorkboardLink[],
  link: WorkboardLink,
): WorkboardLink[] {
  const index = resolveLinkEvictionIndex(links);
  const next = [...links, link];
  return index === undefined ? next : next.filter((_, linkIndex) => linkIndex !== index);
}

function hasDependencyLink(
  links: readonly WorkboardLink[],
  type: DependencyLinkType,
  targetCardId: string,
): boolean {
  return links.some((link) => link.type === type && link.targetCardId === targetCardId);
}

export function withWorkboardDependencyLink(
  card: WorkboardCard,
  targetCardId: string,
  type: DependencyLinkType,
  now: number,
): WorkboardLink[] {
  const links = card.metadata?.links ?? [];
  return hasDependencyLink(links, type, targetCardId)
    ? links
    : appendLinkPreservingDependencies(links, {
        id: randomUUID(),
        type,
        targetCardId,
        createdAt: now,
      });
}

export function assertIdempotentLinkedCreate(
  existing: WorkboardCard,
  requestedParents: readonly string[],
  cards: readonly WorkboardCard[],
): void {
  // Only a matching recorded single parent identifies this request as a linked retry.
  const parentId = existing.metadata?.automation?.createdByCardId;
  if (!parentId || requestedParents.length !== 1 || requestedParents[0] !== parentId) {
    return;
  }
  const parent = cards.find((card) => card.id === parentId);
  if (
    parent &&
    (!hasDependencyLink(existing.metadata?.links ?? [], "parent", parentId) ||
      !hasDependencyLink(parent.metadata?.links ?? [], "child", existing.id))
  ) {
    throw new Error("Existing Workboard card is missing its requested parent dependency.");
  }
}
