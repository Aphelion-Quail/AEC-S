import test from "node:test";
import assert from "node:assert/strict";
import { directiveSchema, idSchema, jobInputSchema, projectInputSchema, taskGraphSchema } from "../src/input.js";

test("requires an explicit directive selector and reprioritize value", () => {
  assert.throws(() => directiveSchema.parse({ action: "cancel" }), /requires projectId, taskIds, or tags/);
  assert.throws(() => directiveSchema.parse({ action: "reprioritize", taskIds: ["task"] }), /requires priority/);
  assert.equal(directiveSchema.parse({ action: "pause", taskIds: ["task"] }).action, "pause");
});

test("rejects option-like Git names and malformed internal Job input", () => {
  const base = { name: "project", repoPath: "/tmp/repo" };
  assert.throws(() => projectInputSchema.parse({ ...base, targetBranch: "--upload-pack=evil" }));
  assert.throws(() => projectInputSchema.parse({ ...base, remoteName: "-origin" }));
  assert.throws(() => jobInputSchema.parse({ command: { program: "node", args: [] }, stdoutPath: "out" }));
  assert.throws(() => projectInputSchema.parse({
    ...base,
    defaultValidation: [{ program: "node", args: [], env: { SECRET: "not-a-public-command-field" } }],
  }));
});

test("rejects Git-ref-invalid identifiers and oversized public input", () => {
  assert.throws(() => idSchema.parse("task..branch"), /consecutive dots/);
  assert.throws(() => idSchema.parse("task.lock"), /\.lock/);
  assert.throws(() => taskGraphSchema.parse({
    projectId: "project",
    tasks: [{
      projectId: "project",
      title: "x".repeat(513),
      goal: "goal",
      scope: { writeGlobs: ["file.txt"], watchGlobs: [], tags: [] },
      acceptanceCriteria: ["done"],
    }],
  }), /too_big|512|at most/i);
});
