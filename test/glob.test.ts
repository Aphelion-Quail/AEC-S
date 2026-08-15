import test from "node:test";
import assert from "node:assert/strict";
import { matchesAny, tasksConflict } from "../src/glob.js";

test("matches repository path globs", () => {
  assert.equal(matchesAny("src/core/a.ts", ["src/core/**"]), true);
  assert.equal(matchesAny("src/ui/a.ts", ["src/core/**"]), false);
  assert.equal(matchesAny("README.md", ["*.md"]), true);
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
