import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories.reverse()) rmSync(directory, { recursive: true, force: true });
});

export function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export function builtCliPath(): string {
  return fileURLToPath(new URL("../src/cli.js", import.meta.url));
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function createGitRepository(): string {
  const repo = tempDir("aec-s-repo-");
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=AEC-S Test", "-c", "user.email=aec-s-test@local", "commit", "-m", "initial"],
    { cwd: repo, stdio: "ignore" },
  );
  return repo;
}
