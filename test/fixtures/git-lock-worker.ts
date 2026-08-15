import { appendFileSync } from "node:fs";
import { withProjectGitLock } from "../../src/git.js";
import type { Project } from "../../src/types.js";

const [repoPath, outputPath, workerId] = process.argv.slice(2);
if (!repoPath || !outputPath || !workerId) throw new Error("git-lock-worker requires repo, output, and id");

const project: Project = {
  id: "shared-project",
  name: "lock fixture",
  repoPath,
  targetBranch: "main",
  remoteName: "origin",
  deliveryMode: "local",
  intent: "",
  defaultValidation: [],
  fullValidation: [],
  requiredChecks: [],
  highRiskGlobs: [],
  maxConcurrency: 2,
  createdAt: new Date().toISOString(),
};

await withProjectGitLock(project, async () => {
  appendFileSync(outputPath, `${workerId}:start:${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  appendFileSync(outputPath, `${workerId}:end:${Date.now()}\n`);
});
