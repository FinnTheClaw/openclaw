import { extname } from "node:path";

type Syntax = "c" | "python" | "shell" | "plain";

const C_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".rs", ".ts", ".tsx"]);
const SHELL_EXTENSIONS = new Set([".bash", ".fish", ".sh", ".zsh"]);

function syntaxFor(filePath: string, content: string): Syntax {
  const extension = extname(filePath).toLowerCase();
  if (C_EXTENSIONS.has(extension)) {
    return "c";
  }
  if (extension === ".py") {
    return "python";
  }
  if (SHELL_EXTENSIONS.has(extension)) {
    return "shell";
  }
  const shebang = content.split(/\r\n|\r|\n|\u2028|\u2029/u, 1)[0] ?? "";
  return /\b(?:bash|dash|fish|ksh|sh|zsh)\b/u.test(shebang) ? "shell" : "plain";
}

function physicalLines(content: string): string[] {
  return content.split(/\r\n|\r|\n|\u2028|\u2029/u);
}

function countPlain(lines: string[]): number {
  return lines.filter((line) => line.trim().length > 0).length;
}

function countCLines(lines: string[], rust: boolean): number {
  let blockDepth = 0;
  let quote = "";
  let rawHashes = -1;
  let regexClass = false;
  let total = 0;
  for (const line of lines) {
    let code = quote !== "" || rawHashes >= 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      const next = line[index + 1] ?? "";
      if (regexClass) {
        code = true;
        if (character === "\\") {
          index += 1;
        } else if (character === "]") {
          regexClass = false;
        }
        continue;
      }
      if (rawHashes >= 0) {
        if (
          character === '"' &&
          line.slice(index + 1, index + 1 + rawHashes) === "#".repeat(rawHashes)
        ) {
          index += rawHashes;
          rawHashes = -1;
        }
        continue;
      }
      if (quote) {
        code = true;
        if (character === "\\") {
          index += 1;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }
      if (blockDepth > 0) {
        if (character === "/" && next === "*" && rust) {
          blockDepth += 1;
          index += 1;
        } else if (character === "*" && next === "/") {
          blockDepth -= 1;
          index += 1;
        }
        continue;
      }
      if (rust && character === "r") {
        const raw = /^r(#{0,255})"/u.exec(line.slice(index));
        if (raw) {
          code = true;
          rawHashes = raw[1]?.length ?? 0;
          index += raw[0].length - 1;
          continue;
        }
      }
      if (character === "/" && next === "/") {
        break;
      }
      if (character === "/" && next === "*") {
        blockDepth = 1;
        index += 1;
        continue;
      }
      if (character === "/" && next === "[") {
        code = true;
        regexClass = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        code = true;
        quote = character;
      } else if (!/\s/u.test(character)) {
        code = true;
      }
    }
    if (code) {
      total += 1;
    }
  }
  return blockDepth === 0 && quote === "" && rawHashes < 0 && !regexClass
    ? total
    : countPlain(lines);
}

function countPythonLines(lines: string[]): number {
  let quote = "";
  let triple = "";
  let total = 0;
  for (const line of lines) {
    let code = quote !== "" || triple !== "";
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      if (triple) {
        if (line.startsWith(triple, index)) {
          index += 2;
          triple = "";
        }
        continue;
      }
      if (quote) {
        code = true;
        if (character === "\\") {
          index += 1;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }
      if (character === "#") {
        break;
      }
      if (
        (character === "'" || character === '"') &&
        line.slice(index, index + 3) === character.repeat(3)
      ) {
        code = true;
        triple = character.repeat(3);
        index += 2;
      } else if (character === "'" || character === '"') {
        code = true;
        quote = character;
      } else if (!/\s/u.test(character)) {
        code = true;
      }
    }
    if (code) {
      total += 1;
    }
  }
  return quote === "" && triple === "" ? total : countPlain(lines);
}

type HereDoc = { delimiter: string; stripTabs: boolean };

function countShellLines(lines: string[]): number {
  let quote = "";
  const hereDocs: HereDoc[] = [];
  let total = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const hereDoc = hereDocs[0];
    if (hereDoc) {
      const candidate = hereDoc.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === hereDoc.delimiter) {
        hereDocs.shift();
      }
      if (line.trim().length > 0) {
        total += 1;
      }
      continue;
    }
    let code = quote !== "" || (lineIndex === 0 && line.startsWith("#!"));
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      if (quote) {
        code = true;
        if (character === "\\" && quote !== "'") {
          index += 1;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }
      if (character === "\\") {
        code = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        code = true;
        quote = character;
        continue;
      }
      if (character === "#" && (index === 0 || /[\s;|&(){}<>]/u.test(line[index - 1] ?? ""))) {
        break;
      }
      if (character === "<" && line[index + 1] === "<") {
        const match = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)(?:\2)/u.exec(line.slice(index));
        if (match) {
          hereDocs.push({ delimiter: match[3] ?? "", stripTabs: match[1] === "-" });
          code = true;
          index += match[0].length - 1;
          continue;
        }
      }
      if (!/\s/u.test(character)) {
        code = true;
      }
    }
    if (code) {
      total += 1;
    }
  }
  return quote === "" && hereDocs.length === 0 ? total : countPlain(lines);
}

export function countSourceLines(content: string, filePath: string): number {
  const lines = physicalLines(content);
  const syntax = syntaxFor(filePath, content);
  if (syntax === "c") {
    return countCLines(lines, extname(filePath).toLowerCase() === ".rs");
  }
  if (syntax === "python") {
    return countPythonLines(lines);
  }
  if (syntax === "shell") {
    return countShellLines(lines);
  }
  return countPlain(lines);
}
