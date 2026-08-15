import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [mode, workspace, output, targetArgument] = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);

if (!mode || !workspace || !output) throw new Error("Usage: fake-agent <mode> <workspace> <output>");

if (mode === "review") {
  writeFileSync(output, JSON.stringify({ verdict: "pass", summary: "Fake review passed", findings: [] }));
  process.exit(0);
}

if (mode === "review-mutate") {
  writeFileSync(join(workspace, "reviewer-leak.txt"), "reviewer must not write\n");
  writeFileSync(output, JSON.stringify({ verdict: "pass", summary: "Invalid mutating review", findings: [] }));
  process.exit(0);
}

if (mode === "review-validation") {
  const match = stdin.match(/envelope at (.+)\./);
  if (!match?.[1]) throw new Error("Review context path not found");
  const context = JSON.parse(readFileSync(match[1], "utf8")) as { validation?: Array<{ status?: string }> };
  const hasPassedEvidence = context.validation?.some((item) => item.status === "passed") ?? false;
  writeFileSync(output, JSON.stringify(hasPassedEvidence
    ? { verdict: "pass", summary: "Validation evidence received", findings: [] }
    : { verdict: "fail", summary: "Validation evidence missing", findings: [] }));
  process.exit(0);
}

if (mode === "review-file") {
  const target = join(workspace, targetArgument ?? "repaired.txt");
  const repaired = readFileSync(target, "utf8").includes("repaired");
  writeFileSync(output, JSON.stringify(repaired
    ? { verdict: "pass", summary: "Repair accepted", findings: [] }
    : {
        verdict: "fail",
        summary: "Repair required",
        findings: [{ severity: "blocking", summary: "Content is not repaired", requiredChange: "Repair the content" }],
      }));
  process.exit(0);
}

if (mode === "blocked") {
  writeFileSync(output, JSON.stringify({ status: "blocked", summary: "Fake agent cannot continue", notes: ["needs decision"] }));
  process.exit(0);
}

if (mode === "architecture-blocked") {
  writeFileSync(output, JSON.stringify({
    status: "blocked",
    summary: "Architecture direction is required",
    notes: ["Two durable designs are possible"],
    blocker: { kind: "architecture", question: "Which component owns the durable state?" },
  }));
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
if (mode === "timeline-slow") {
  if (!targetArgument) throw new Error("timeline-slow requires a timeline path");
  appendFileSync(targetArgument, `${envelope.task.id}:start\n`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  appendFileSync(targetArgument, `${envelope.task.id}:end\n`);
}
mkdirSync(dirname(target), { recursive: true });
const content = mode === "bad" ? "needs repair\n" : mode === "repair" ? "repaired\n" : `implemented by ${envelope.task.id}\n`;
writeFileSync(target, content);
writeFileSync(output, JSON.stringify({ status: "complete", summary: "Fake implementation complete", notes: [] }));
