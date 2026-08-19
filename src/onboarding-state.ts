import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";
import type { AecSPaths } from "./paths.js";

export type FrontAgentConfiguration = {
  kind: "workbuddy" | "custom" | "skipped";
  configured: boolean;
  detail?: string;
};

export type OnboardingState = {
  schemaVersion: 1;
  status: "in_progress" | "complete";
  language: "en" | "zh-CN";
  serviceEnabled?: boolean;
  mcpEndpoint?: string;
  frontAgent?: FrontAgentConfiguration;
  projectId?: string;
  startedAt: string;
  completedAt?: string;
};

export function onboardingStatePath(paths: AecSPaths): string {
  return join(paths.home, "onboarding.json");
}

export function readOnboardingState(paths: AecSPaths): OnboardingState | undefined {
  const path = onboardingStatePath(paths);
  if (!existsSync(path)) return undefined;
  const value = readJson<Partial<OnboardingState>>(path);
  if (value.schemaVersion !== 1 || !["in_progress", "complete"].includes(value.status ?? "") ||
      !["en", "zh-CN"].includes(value.language ?? "") || typeof value.startedAt !== "string") {
    throw new Error(`AEC-S onboarding state is invalid: ${path}`);
  }
  return value as OnboardingState;
}

export function writeOnboardingState(paths: AecSPaths, state: OnboardingState): void {
  writeJsonAtomic(onboardingStatePath(paths), state);
}

export function onboardingComplete(paths: AecSPaths): boolean {
  return readOnboardingState(paths)?.status === "complete";
}
