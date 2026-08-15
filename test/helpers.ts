import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createGitRepository(): string {
  const repo = tempDir("aec-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=AEC Test", "-c", "user.email=aec-test@local", "commit", "-m", "initial"],
    { cwd: repo, stdio: "ignore" },
  );
  return repo;
}
