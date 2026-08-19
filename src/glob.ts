import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";

type GlobToken = { kind: "literal"; value: string } | { kind: "one" | "star" | "globstar" | "globstar-slash" };

const globCache = new Map<string, GlobToken[]>();
const MAX_GLOB_CACHE_ENTRIES = 1_024;

function compileGlob(glob: string): GlobToken[] {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  const cached = globCache.get(normalized);
  if (cached) return cached;
  const tokens: GlobToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          tokens.push({ kind: "globstar-slash" });
        } else {
          tokens.push({ kind: "globstar" });
        }
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (char === "?") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "literal", value: char });
    }
  }
  if (globCache.size >= MAX_GLOB_CACHE_ENTRIES) {
    const oldest = globCache.keys().next().value as string | undefined;
    if (oldest !== undefined) globCache.delete(oldest);
  }
  globCache.set(normalized, tokens);
  return tokens;
}

function matchesGlob(path: string, glob: string): boolean {
  const tokens = compileGlob(glob);
  const memo = new Map<string, boolean>();
  const visit = (tokenIndex: number, pathIndex: number): boolean => {
    const key = `${tokenIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const token = tokens[tokenIndex];
    let result: boolean;
    if (!token) {
      result = pathIndex === path.length;
    } else if (token.kind === "literal") {
      result = path[pathIndex] === token.value && visit(tokenIndex + 1, pathIndex + 1);
    } else if (token.kind === "one") {
      result = pathIndex < path.length && path[pathIndex] !== "/" && visit(tokenIndex + 1, pathIndex + 1);
    } else if (token.kind === "star") {
      result = visit(tokenIndex + 1, pathIndex) || (
        pathIndex < path.length && path[pathIndex] !== "/" && visit(tokenIndex, pathIndex + 1)
      );
    } else if (token.kind === "globstar") {
      result = visit(tokenIndex + 1, pathIndex) || (pathIndex < path.length && visit(tokenIndex, pathIndex + 1));
    } else {
      result = visit(tokenIndex + 1, pathIndex);
      for (let index = pathIndex; !result && index < path.length; index += 1) {
        if (path[index] === "/") result = visit(tokenIndex + 1, index + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

export function matchesAny(path: string, globs: string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return globs.some((glob) => matchesGlob(normalized, glob));
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
  if (!leftWildcard && matchesGlob(normalizeGlob(left), right)) return true;
  if (!rightWildcard && matchesGlob(normalizeGlob(right), left)) return true;
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
  left: { writeGlobs: string[]; watchGlobs?: string[]; impactGlobs?: string[] },
  right: { writeGlobs: string[]; watchGlobs?: string[]; impactGlobs?: string[] },
): boolean {
  if (left.writeGlobs.length === 0 || right.writeGlobs.length === 0) return true;
  return (
    globsMayOverlap(left.writeGlobs, [...right.writeGlobs, ...(right.watchGlobs ?? right.impactGlobs ?? [])]) ||
    globsMayOverlap(right.writeGlobs, [...left.writeGlobs, ...(left.watchGlobs ?? left.impactGlobs ?? [])])
  );
}

export function relativeInside(root: string, candidate: string): string {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const value = relative(realRoot, realCandidate);
  if (value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith(sep))) return value;
  throw new Error(`Path escapes workspace: ${candidate}`);
}
