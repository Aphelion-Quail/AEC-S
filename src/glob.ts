import { realpathSync } from "node:fs";
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
      if (globPairMayOverlap(a, b)) return true;
    }
  }
  return false;
}

function globPairMayOverlap(left: string, right: string): boolean {
  const leftWildcard = /[?*]/.test(left);
  const rightWildcard = /[?*]/.test(right);
  if (!leftWildcard && !rightWildcard) return normalizeGlob(left) === normalizeGlob(right);
  if (!leftWildcard && globToRegExp(right).test(normalizeGlob(left))) return true;
  if (!rightWildcard && globToRegExp(left).test(normalizeGlob(right))) return true;
  const leftRoot = literalDirectoryRoot(left);
  const rightRoot = literalDirectoryRoot(right);
  if (!leftRoot || !rightRoot) return true;
  return (
    leftRoot === rightRoot ||
    leftRoot.startsWith(`${rightRoot}/`) ||
    rightRoot.startsWith(`${leftRoot}/`)
  );
}

function normalizeGlob(glob: string): string {
  return glob.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function literalDirectoryRoot(glob: string): string {
  const segments = normalizeGlob(glob).split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[?*]/.test(segment)) break;
    literal.push(segment);
  }
  if (!/[?*]/.test(glob)) literal.pop();
  return literal.join("/");
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
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const value = relative(realRoot, realCandidate);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep))) return value;
  throw new Error(`Path escapes workspace: ${candidate}`);
}
