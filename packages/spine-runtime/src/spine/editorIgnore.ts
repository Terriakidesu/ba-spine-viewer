export interface EditorIgnoreRule {
  source: string;
  negated: boolean;
  directoryOnly: boolean;
  matches: RegExp;
  matchesExact: RegExp;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          result += "(?:[^/]+/)*";
        } else {
          result += ".*";
        }
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        const contents = pattern.slice(index + 1, end).replace(/\\/g, "\\\\");
        result += `[${contents}]`;
        index = end;
      } else {
        result += "\\[";
      }
    } else {
      result += escapeRegex(character);
    }
  }
  return result;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function ruleForLine(line: string): EditorIgnoreRule | null {
  let pattern = line.trim();
  if (!pattern || pattern === "." || pattern.startsWith("#")) return null;

  let negated = false;
  if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) pattern = pattern.slice(1);
  else if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  const anchored = pattern.startsWith("/");
  const directoryOnly = pattern.endsWith("/");
  pattern = normalizedPath(pattern.replace(/\/$/, ""));
  if (!pattern) return null;
  const hasSlash = anchored || pattern.includes("/");
  const body = globRegex(pattern);
  const exact = hasSlash ? `^${body}$` : `(?:^|/)${body}$`;
  const descendants = hasSlash ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
  return {
    source: line,
    negated,
    directoryOnly,
    matches: new RegExp(descendants),
    matchesExact: new RegExp(exact),
  };
}

export function parseEditorIgnore(value: string): EditorIgnoreRule[] {
  return value.split(/\r?\n/).map(ruleForLine).filter((rule): rule is EditorIgnoreRule => rule !== null);
}

/** Match root-relative paths using the editor's portable gitignore subset. */
export function isEditorIgnored(path: string, rules: readonly EditorIgnoreRule[], isDirectory = false): boolean {
  const normalized = normalizedPath(path);
  if (!normalized) return false;
  let ignored = false;
  for (const rule of rules) {
    if (!rule.matches.test(normalized)) continue;
    if (rule.directoryOnly && !isDirectory && rule.matchesExact.test(normalized)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}
