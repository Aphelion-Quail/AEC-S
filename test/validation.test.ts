import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Project, Task } from "../src/types.js";
import { authoritativeCommands, resolveValidationCommand, shouldRunFullValidation } from "../src/validation.js";
import { outOfScopePaths } from "../src/git.js";
import { tempDir } from "./helpers.js";

const project = {
  id: "project",
  name: "fixture",
  repoPath: "/tmp/fixture",
  targetBranch: "main",
  remoteName: "origin",
  deliveryMode: "local",
  intent: "",
  defaultValidation: [{ program: "npm", args: ["test", "--", "unit"] }],
  fullValidation: [{ program: "npm", args: ["test"] }],
  requiredChecks: [],
  highRiskGlobs: ["src/shared/**", "package-lock.json"],
  maxConcurrency: 2,
  createdAt: new Date().toISOString(),
} satisfies Project;

const task = {
  id: "task",
  projectId: "project",
  title: "UI",
  goal: "Change UI",
  scope: { writeGlobs: ["src/ui/**"], impactGlobs: [], tags: ["ui"] },
  dependsOn: [],
  constraints: [],
  acceptanceCriteria: ["works"],
  validationCommands: [{ program: "npm", args: ["test", "--", "ui"] }],
  requiredCapabilities: [],
  requiresFullValidation: false,
  priority: 0,
  decisionIds: [],
  status: "ready",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies Task;

test("does not run full validation for ordinary task changes", () => {
  assert.equal(shouldRunFullValidation(project, task, ["src/ui/button.ts"]), false);
  assert.equal(authoritativeCommands(project, task, ["src/ui/button.ts"]).length, 2);
});

test("runs full validation only for explicit or high-risk changes", () => {
  assert.equal(shouldRunFullValidation(project, task, ["src/shared/types.ts"]), true);
  assert.equal(authoritativeCommands(project, task, ["src/shared/types.ts"]).length, 3);
});

test("allows empty write scope while forcing full validation", () => {
  const unscopedTask: Task = { ...task, scope: { writeGlobs: [], impactGlobs: [], tags: [] } };
  assert.equal(shouldRunFullValidation(project, unscopedTask, ["src/anything.ts"]), true);
  assert.deepEqual(outOfScopePaths(unscopedTask, ["src/anything.ts"]), []);
});

test("rejects validation cwd that escapes through a workspace symlink", () => {
  const workspace = tempDir("aec-s-validation-workspace-");
  const outside = tempDir("aec-s-validation-outside-");
  mkdirSync(join(outside, "target"));
  symlinkSync(join(outside, "target"), join(workspace, "linked"));
  assert.throws(
    () => resolveValidationCommand({ program: "true", args: [], cwd: "linked" }, workspace),
    /Path escapes workspace/,
  );
});
