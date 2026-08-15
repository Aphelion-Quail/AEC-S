import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [mode, workspace, output] = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);

if (!mode || !workspace || !output) throw new Error("Usage: fake-agent <mode> <workspace> <output>");

if (mode === "review") {
  writeFileSync(output, JSON.stringify({ verdict: "pass", summary: "Fake review passed", findings: [] }));
  process.exit(0);
}

if (mode === "blocked") {
  writeFileSync(output, JSON.stringify({ status: "blocked", summary: "Fake agent cannot continue", notes: ["needs decision"] }));
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
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `implemented by ${envelope.task.id}\n`);
writeFileSync(output, JSON.stringify({ status: "complete", summary: "Fake implementation complete", notes: [] }));
