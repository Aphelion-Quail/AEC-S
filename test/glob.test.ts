import test from "node:test";
import assert from "node:assert/strict";
import { globsMayOverlap, matchesAny, tasksConflict } from "../src/glob.js";

test("matches repository path globs", () => {
  assert.equal(matchesAny("src/core/a.ts", ["src/core/**"]), true);
  assert.equal(matchesAny("src/ui/a.ts", ["src/core/**"]), false);
  assert.equal(matchesAny("README.md", ["*.md"]), true);
  assert.equal(matchesAny("src/a.ts", ["src/?.ts"]), true);
  assert.equal(matchesAny("src/ab.ts", ["src/?.ts"]), false);
  assert.equal(matchesAny("src/file.ts", ["src/**/file.ts"]), true);
  assert.equal(matchesAny("src/nested/file.ts", ["src/**/file.ts"]), true);
  assert.equal(matchesAny("src/a.ts", ["src/[ab].ts"]), false, "character classes are intentionally literal");
  assert.equal(matchesAny("src/a.ts", ["src/{a,b}.ts"]), false, "braces are intentionally literal");
});

test("allows only scope-independent tasks to run concurrently", () => {
  assert.equal(
    tasksConflict(
      { writeGlobs: ["src/ui/**"], impactGlobs: ["src/shared/**"] },
      { writeGlobs: ["src/core/**"], impactGlobs: [] },
    ),
    false,
  );
  assert.equal(
    tasksConflict(
      { writeGlobs: ["src/ui/**"], impactGlobs: ["src/shared/**"] },
      { writeGlobs: ["src/shared/**"], impactGlobs: [] },
    ),
    true,
  );
  assert.equal(
    tasksConflict(
      { writeGlobs: [], impactGlobs: [] },
      { writeGlobs: ["src/core/**"], impactGlobs: [] },
    ),
    true,
  );
});

test("treats wildcard intersections as conflicts unless disjointness is proven", () => {
  assert.equal(globsMayOverlap(["src/aaa*"], ["src/aa*a"]), true);
  assert.equal(
    tasksConflict(
      { writeGlobs: ["src/aaa*"], impactGlobs: [] },
      { writeGlobs: ["src/aa*a"], impactGlobs: [] },
    ),
    true,
  );
  assert.equal(globsMayOverlap(["src/a/**"], ["src/b/**"]), false);
});
