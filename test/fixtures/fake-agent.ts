import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const [mode, workspace, output, targetArgument] = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);

if (!mode || !workspace || !output) throw new Error("Usage: fake-agent <mode> <workspace> <output>");
const outputPath = output;

function writeWorker(value: Record<string, unknown>): void {
  writeFileSync(outputPath, JSON.stringify({ blocker: null, scopeExpansion: null, ...value }));
}

function writeReview(value: { verdict: "pass" | "fail"; summary: string; findings: Array<Record<string, unknown>> }): void {
  writeFileSync(outputPath, JSON.stringify({
    ...value,
    completed: true,
    findings: value.findings.map((finding) => ({
      file: null, line: null, requiredChange: null, evidence: null, category: null, ...finding,
    })),
  }));
}

if (mode === "review") {
  writeReview({ verdict: "pass", summary: "Fake review passed", findings: [] });
  process.exit(0);
}

if (mode === "review-malformed") {
  writeFileSync(outputPath, JSON.stringify({ verdict: "approved", result: "pass", findings: [] }));
  process.exit(0);
}

if (mode === "review-empty-fail") {
  writeReview({ verdict: "fail", summary: "Rejected without actionable evidence", findings: [] });
  process.exit(0);
}

if (mode === "review-mutate") {
  writeFileSync(join(workspace, "reviewer-leak.txt"), "reviewer must not write\n");
  writeReview({ verdict: "pass", summary: "Invalid mutating review", findings: [] });
  process.exit(0);
}

if (mode === "review-validation") {
  const match = stdin.match(/envelope at (.+)\./);
  if (!match?.[1]) throw new Error("Review context path not found");
  const context = JSON.parse(readFileSync(match[1], "utf8")) as { validation?: Array<{ status?: string }> };
  const hasPassedEvidence = context.validation?.some((item) => item.status === "passed") ?? false;
  writeReview(hasPassedEvidence
    ? { verdict: "pass", summary: "Validation evidence received", findings: [] }
    : { verdict: "fail", summary: "Validation evidence missing", findings: [] });
  process.exit(0);
}

if (mode === "review-file") {
  const target = join(workspace, targetArgument ?? "repaired.txt");
  const repaired = readFileSync(target, "utf8").includes("repaired");
  writeReview(repaired
    ? { verdict: "pass", summary: "Repair accepted", findings: [] }
    : {
        verdict: "fail",
        summary: "Repair required",
        findings: [{ severity: "blocking", summary: "Content is not repaired", requiredChange: "Repair the content" }],
      });
  process.exit(0);
}

if (mode === "blocked") {
  writeWorker({ status: "blocked", summary: "Fake agent cannot continue", notes: ["needs decision"] });
  process.exit(0);
}

if (mode === "architecture-blocked") {
  writeWorker({
    status: "blocked",
    summary: "Architecture direction is required",
    notes: ["Two durable designs are possible"],
    blocker: { kind: "architecture", question: "Which component owns the durable state?" },
  });
  process.exit(0);
}

if (mode === "scope-expansion") {
  writeWorker({
    status: "complete",
    summary: "Scope proposal produced",
    notes: [],
    scopeExpansion: {
      addWriteGlobs: ["approved.txt"],
      addWatchGlobs: [],
      evidence: "A bounded additional file is required",
    },
  });
  process.exit(0);
}

if (mode === "malformed-result") {
  writeFileSync(outputPath, JSON.stringify({ status: "complete", summary: "Missing required fields" }));
  process.exit(0);
}

const match = stdin.match(/envelope at (.+)\./);
if (!match?.[1]) throw new Error(`Context path not found in prompt: ${stdin}`);
const envelope = JSON.parse(readFileSync(match[1], "utf8")) as {
  task: { id: string; scope: { writeGlobs: string[] } };
};
const declared = envelope.task.scope.writeGlobs[0];
if (!declared || declared.includes("*") || declared.includes("?")) throw new Error("Fake agent requires one concrete write path");
const target = join(workspace, declared);
if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 750));
if (mode === "timeline-slow" || mode === "timeline-fast" || mode === "timeline-barrier" || mode === "timeline-triple-barrier") {
  if (!targetArgument) throw new Error(`${mode} requires a timeline path`);
  appendFileSync(targetArgument, `${envelope.task.id}:start\n`);
  if (mode === "timeline-barrier" || mode === "timeline-triple-barrier") {
    const deadline = Date.now() + 30_000;
    let startedTasks = new Set<string>();
    while (Date.now() < deadline) {
      startedTasks = new Set(
        readFileSync(targetArgument, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter((entry) => entry.endsWith(":start"))
          .map((entry) => entry.slice(0, -":start".length)),
      );
      if (startedTasks.size >= (mode === "timeline-triple-barrier" ? 3 : 2)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const required = mode === "timeline-triple-barrier" ? 3 : 2;
    if (startedTasks.size < required) throw new Error("Independent executor did not reach the concurrency barrier");
  } else {
    await new Promise((resolve) => setTimeout(resolve, mode === "timeline-slow" ? 750 : 150));
  }
  appendFileSync(targetArgument, `${envelope.task.id}:end\n`);
}
mkdirSync(dirname(target), { recursive: true });
const content = mode === "bad" ? "needs repair\n" : mode === "repair" ? "repaired\n" : `implemented by ${envelope.task.id}\n`;
writeFileSync(target, content);
if (mode === "commit-authority-violation") {
  execFileSync("git", ["add", "--", declared], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "unauthorized runtime commit"], { cwd: workspace });
}
writeWorker({ status: "complete", summary: "Fake implementation complete", notes: [] });
