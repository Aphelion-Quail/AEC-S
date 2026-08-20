import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";

type GlobToken = { kind: "literal"; value: string } | { kind: "one" | "star" | "globstar" | "globstar-slash" };
type CompiledGlob = { normalized: string; tokens: GlobToken[]; hasWildcard: boolean; literalRoot: string };

const globCache = new Map<string, CompiledGlob>();
const MAX_GLOB_CACHE_ENTRIES = 1_024;

function compileGlob(glob: string): CompiledGlob {
  const normalized = normalizeGlob(glob);
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
  const segments = normalized.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[?*]/.test(segment)) break;
    literal.push(segment);
  }
  const hasWildcard = /[?*]/.test(normalized);
  if (!hasWildcard) literal.pop();
  const compiled = { normalized, tokens, hasWildcard, literalRoot: literal.join("/") };
  globCache.set(normalized, compiled);
  return compiled;
}

function matchesGlob(path: string, glob: string): boolean {
  const { tokens } = compileGlob(glob);
  const width = path.length + 1;
  const memo = new Uint8Array((tokens.length + 1) * width);
  const visit = (tokenIndex: number, pathIndex: number): boolean => {
    const key = tokenIndex * width + pathIndex;
    const known = memo[key];
    if (known !== 0) return known === 2;
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
      const nextSlash = path.indexOf("/", pathIndex);
      result = visit(tokenIndex + 1, pathIndex) || (nextSlash >= 0 && visit(tokenIndex, nextSlash + 1));
    }
    memo[key] = result ? 2 : 1;
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
  const leftCompiled = left.map(compileGlob);
  const rightCompiled = right.map(compileGlob);
  if (leftCompiled.every((glob) => glob.literalRoot) && rightCompiled.every((glob) => glob.literalRoot)) {
    const leftTopLevel = new Set(leftCompiled.map((glob) => glob.literalRoot.split("/", 1)[0]!));
    if (!rightCompiled.some((glob) => leftTopLevel.has(glob.literalRoot.split("/", 1)[0]!))) return false;
  }
  for (const a of left) {
    for (const b of right) {
      if (globPairMayOverlap(a, b)) return true;
    }
  }
  return false;
}

function globPairMayOverlap(left: string, right: string): boolean {
  const leftCompiled = compileGlob(left);
  const rightCompiled = compileGlob(right);
  if (!leftCompiled.hasWildcard && !rightCompiled.hasWildcard) return leftCompiled.normalized === rightCompiled.normalized;
  if (!leftCompiled.hasWildcard) return matchesGlob(leftCompiled.normalized, right);
  if (!rightCompiled.hasWildcard) return matchesGlob(rightCompiled.normalized, left);
  const leftRoot = leftCompiled.literalRoot;
  const rightRoot = rightCompiled.literalRoot;
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
