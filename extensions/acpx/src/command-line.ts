/**
 * Small shell-command helpers for ACPX-launched processes. Splitting supports
 * simple quoted command strings from config without invoking a shell parser.
 */
/** Quote one command argument for display or config serialization. */
export function quoteCommandPart(value: string): string {
  return JSON.stringify(value);
}

/** Split a command string into argv-like parts using simple quote/backslash rules. */
export function splitCommandParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      tokenStarted = true;
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      tokenStarted = true;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    tokenStarted = true;
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    parts.push(current);
  }
  return parts;
}
