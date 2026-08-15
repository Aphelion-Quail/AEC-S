import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startSupervisedJob, waitForJob } from "../src/job.js";
import { tempDir } from "./helpers.js";

test("does not report a timeout until the supervised process has exited", async () => {
  const directory = tempDir("aec-timeout-");
  const marker = join(directory, "late-write.txt");
  const inputPath = join(directory, "job.input.json");
  const resultPath = join(directory, "job.result.json");
  const job = startSupervisedJob({
    command: {
      program: process.execPath,
      args: ["-e", `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`],
      timeoutSeconds: 0.05,
    },
    stdoutPath: join(directory, "job.stdout.log"),
    stderrPath: join(directory, "job.stderr.log"),
    resultPath,
  }, inputPath);
  const result = await waitForJob(job, 1);
  assert.equal(result.status, "timed_out");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false, "a timed-out process must not keep mutating the workspace");
});
