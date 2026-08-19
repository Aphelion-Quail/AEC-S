import type { ChildEnvironmentProfile } from "./types.js";
import { nodeCoverageDirectory } from "./isolation.js";

const SAFE_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
] as const;

const PROFILE_KEYS: Record<Exclude<ChildEnvironmentProfile, "restricted">, readonly string[]> = {
  codex: ["CODEX_HOME", "OPENAI_API_KEY"],
  kimi: ["KIMI_SHARE_DIR", "MOONSHOT_API_KEY"],
  deepseek_harness: ["DSH_HOME", "DEEPSEEK_API_KEY"],
};

function copyDefined(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, keys: readonly string[]): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export function childEnvironment(
  profile: ChildEnvironmentProfile = "restricted",
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  copyDefined(environment, source, SAFE_ENVIRONMENT_KEYS);
  const coverageDirectory = nodeCoverageDirectory(source);
  if (coverageDirectory) environment.NODE_V8_COVERAGE = coverageDirectory;
  if (profile !== "restricted") copyDefined(environment, source, PROFILE_KEYS[profile]);
  return { ...environment, ...overrides };
}
