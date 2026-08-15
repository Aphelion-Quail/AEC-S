import { relative, sep } from "node:path";

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

export function globsMayOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  for (const a of left) {
    for (const b of right) {
      const staticA = a.split(/[?*]/, 1)[0]!.replace(/\/$/, "");
      const staticB = b.split(/[?*]/, 1)[0]!.replace(/\/$/, "");
      if (!staticA || !staticB) return true;
      if (staticA === staticB || staticA.startsWith(`${staticB}/`) || staticB.startsWith(`${staticA}/`)) return true;
      if (globToRegExp(a).test(b) || globToRegExp(b).test(a)) return true;
    }
  }
  return false;
}

export function tasksConflict(
  left: { writeGlobs: string[]; impactGlobs: string[] },
  right: { writeGlobs: string[]; impactGlobs: string[] },
): boolean {
  if (left.writeGlobs.length === 0 || right.writeGlobs.length === 0) return true;
  return (
    globsMayOverlap(left.writeGlobs, [...right.writeGlobs, ...right.impactGlobs]) ||
    globsMayOverlap(right.writeGlobs, [...left.writeGlobs, ...left.impactGlobs])
  );
}

export function relativeInside(root: string, candidate: string): string {
  const value = relative(root, candidate);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep))) return value;
  throw new Error(`Path escapes workspace: ${candidate}`);
}
