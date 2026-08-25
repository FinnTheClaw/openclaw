import type { PromptTemplate } from "./types.js";

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let hasToken = false;

  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        hasToken = true;
        current += char;
      }
    } else if (char === '"' || char === "'") {
      hasToken = true;
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      hasToken = true;
      current += char;
    }
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

function parseSafeNonNegativeInteger(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments.
 *
 * Unsafe integer placeholders resolve to empty text instead of throwing, so malformed templates cannot abort prompt
 * loading or invocation.
 */
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  // Resolve placeholders in one pass so argument text cannot become a second template.
  return content.replace(
    /\$(\d+)|\$\{@:(\d+)(?::(\d+))?\}|\$ARGUMENTS|\$@/g,
    (_match, num: string | undefined, startStr: string | undefined, lengthStr?: string) => {
      if (num !== undefined) {
        const parsed = parseSafeNonNegativeInteger(num);
        return parsed === undefined || parsed <= 0 ? "" : (args[parsed - 1] ?? "");
      }
      if (startStr !== undefined) {
        const parsedStart = parseSafeNonNegativeInteger(startStr);
        if (parsedStart === undefined) {
          return "";
        }
        // Prompt templates have no shell $0, so a zero start maps to the first argument.
        const start = Math.max(parsedStart - 1, 0);
        if (lengthStr !== undefined) {
          const length = parseSafeNonNegativeInteger(lengthStr);
          return length === undefined ? "" : args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
      }
      return allArgs;
    },
  );
}

/** Format a prompt template invocation using command-style argument substitution. */
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: string[] = [],
): string {
  return substituteArgs(template.content, args);
}
