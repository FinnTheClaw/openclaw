/**
 * Mutate `MdAst` at an OcPath. Returns a new AST; original unchanged.
 *
 *   oc://FILE/[frontmatter]/key   → frontmatter value
 *   oc://FILE/section/item/field  → item.kv.value
 *
 * Section bodies aren't writable through this primitive.
 *
 * @module @openclaw/oc-path/edit
 */

import type { AstBlock, AstItem, FrontmatterEntry, MdAst } from "./ast.js";
import { formatFrontmatterValue } from "./frontmatter-format.js";
import { formatOcPath, type OcPath } from "./oc-path.js";
import { parseMd } from "./parse.js";
import { guardSentinel } from "./sentinel.js";

type MdEditResult =
  | { readonly ok: true; readonly ast: MdAst }
  | {
      readonly ok: false;
      readonly reason: "unresolved" | "not-writable" | "no-item-kv";
    };

// Sentinel guard at the boundary keeps md symmetric with jsonc/jsonl,
// which both reject sentinel values before they reach the AST.
export function setMdOcPath(ast: MdAst, path: OcPath, newValue: string): MdEditResult {
  guardSentinel(newValue, formatOcPath(path));
  if (path.section === "[frontmatter]") {
    const key = path.item ?? path.field;
    if (key === undefined) {
      return { ok: false, reason: "unresolved" };
    }
    const idx = ast.frontmatter.findIndex((e) => e.key === key);
    if (idx === -1) {
      return { ok: false, reason: "unresolved" };
    }
    const existing = ast.frontmatter[idx];
    if (existing === undefined) {
      return { ok: false, reason: "unresolved" };
    }
    const newEntry: FrontmatterEntry = { ...existing, value: newValue };
    const newFm = ast.frontmatter.slice();
    newFm[idx] = newEntry;
    return finalize({ ...ast, frontmatter: newFm });
  }

  if (path.section === undefined || path.item === undefined || path.field === undefined) {
    return { ok: false, reason: "not-writable" };
  }

  const sectionSlug = path.section.toLowerCase();
  const blockIdx = ast.blocks.findIndex((b) => b.slug === sectionSlug);
  if (blockIdx === -1) {
    return { ok: false, reason: "unresolved" };
  }
  const block = ast.blocks[blockIdx];
  if (block === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  const itemSlug = path.item.toLowerCase();
  const itemIdx = block.items.findIndex((i) => i.slug === itemSlug);
  if (itemIdx === -1) {
    return { ok: false, reason: "unresolved" };
  }
  const item = block.items[itemIdx];
  if (item === undefined) {
    return { ok: false, reason: "unresolved" };
  }
  if (item.kv === undefined) {
    return { ok: false, reason: "no-item-kv" };
  }
  if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) {
    return { ok: false, reason: "unresolved" };
  }

  const newItem: AstItem = { ...item, kv: { key: item.kv.key, value: newValue } };
  const newItems = block.items.slice();
  newItems[itemIdx] = newItem;
  const newBlock: AstBlock = {
    ...block,
    items: newItems,
    bodyText: rebuildBlockBody(block, item, newValue),
  };
  const newBlocks = ast.blocks.slice();
  newBlocks[blockIdx] = newBlock;
  return finalize({ ...ast, blocks: newBlocks });
}

// The parser's source line identifies the selected list item, even when an
// earlier fenced/indented example contains the same text.
function rebuildBlockBody(block: AstBlock, item: AstItem, newValue: string): string {
  const lines = block.bodyText.split("\n");
  const index = item.line - block.line - 1;
  const line = lines[index];
  if (line === undefined || item.kv === undefined) {
    return block.bodyText;
  }
  const re = new RegExp(
    `^([ \\t]*(?:[-+*]|\\d+[.)])[ \\t]+${escapeRegex(item.kv.key)}[ \\t]*:[ \\t]*).*$`,
  );
  lines[index] = line.replace(re, (_match, prefix: string) => `${prefix}${newValue}`);
  return lines.join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finalize(ast: MdAst): MdEditResult {
  const parts: string[] = [];
  if (ast.frontmatter.length > 0) {
    parts.push("---");
    for (const fm of ast.frontmatter) {
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push("---");
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(ast.preamble);
  }
  for (const block of ast.blocks) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {
      parts.push(block.bodyText);
    }
  }
  return { ok: true, ast: parseMd(parts.join("\n")).ast };
}
