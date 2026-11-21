/** Native systemd EnvironmentFile value decoding; no filesystem or service access. */
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";

function decodeSystemdEnvironmentFileValue(
  rawValue: string,
  start: number,
): {
  value: string;
  literalDollar: boolean;
  end: number;
} {
  type ParseState =
    | "pre"
    | "unquoted"
    | "unquoted-escape"
    | "single-quoted"
    | "double-quoted"
    | "double-quoted-escape";

  // Match systemd parse_env_file_internal: closing quotes return to pre ("foo"bar -> foobar).
  let state: ParseState = "pre";
  let decoded = "";
  let literalDollar = false;
  let trailingWhitespaceStart: number | undefined;
  let end = start;
  for (; end < rawValue.length; end++) {
    const char = rawValue.charAt(end);
    // Only an unquoted, unescaped newline ends the logical assignment.
    if (char === "\n" && (state === "pre" || state === "unquoted")) {
      end++;
      break;
    }
    const whitespace = char === " " || char === "\t" || char === "\r";
    if (state === "pre") {
      if (whitespace) {
        continue;
      }
      if (char === "'") {
        state = "single-quoted";
        continue;
      }
      if (char === '"') {
        state = "double-quoted";
        continue;
      }
      if (char === "\\") {
        state = "unquoted-escape";
        continue;
      }
      state = "unquoted";
      decoded += char;
      continue;
    }
    if (state === "unquoted") {
      if (char === "\\") {
        state = "unquoted-escape";
        trailingWhitespaceStart = undefined;
        continue;
      }
      if (whitespace) {
        trailingWhitespaceStart ??= decoded.length;
      } else {
        trailingWhitespaceStart = undefined;
      }
      decoded += char;
      continue;
    }
    if (state === "unquoted-escape") {
      state = "unquoted";
      if (char !== "\n") {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    if (state === "single-quoted") {
      if (char === "'") {
        state = "pre";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    if (state === "double-quoted") {
      if (char === '"') {
        state = "pre";
      } else if (char === "\\") {
        state = "double-quoted-escape";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    state = "double-quoted";
    if (char === "\n") {
      continue;
    }
    if (['"', "\\", "`", "$"].includes(char)) {
      literalDollar ||= char === "$";
      decoded += char;
    } else {
      decoded += `\\${char}`;
    }
  }
  if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
    decoded = decoded.slice(0, trailingWhitespaceStart);
  }
  return { value: decoded, literalDollar, end };
}

export function parseSystemdEnvironmentFile(
  content: string,
): Array<{ key: string; value: string; literalShellReference: boolean }> {
  const assignments: Array<{ key: string; value: string; literalShellReference: boolean }> = [];
  let offset = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const lineEnd = newline === -1 ? content.length : newline;
    const rawLine = content.slice(offset, lineEnd);
    const trimmedStart = rawLine.trimStart();
    const eq = rawLine.indexOf("=");
    const key = eq < 0 ? "" : rawLine.slice(0, eq).trim();
    if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";") || !key) {
      offset = newline === -1 ? content.length : newline + 1;
      continue;
    }
    const decoded = decodeSystemdEnvironmentFileValue(content, offset + eq + 1);
    offset = decoded.end;
    assignments.push({
      key,
      value: decoded.value,
      literalShellReference: decoded.literalDollar && isUnresolvedShellReference(decoded.value),
    });
  }
  return assignments;
}
