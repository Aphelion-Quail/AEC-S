import type { RunPhase } from "./types.js";
import { AEC_ERROR, isAecError, type AecErrorCode } from "./errors.js";
import { redactText } from "./redaction.js";

export type PhaseErrorCategory =
  | "agent_capacity"
  | "github_checks"
  | "reviewer_mutation"
  | "runtime_authority"
  | "unclassified";

export type ClassifiedPhaseError = {
  category: PhaseErrorCategory;
  code?: AecErrorCode;
  message: string;
};

export function classifyPhaseError(error: unknown, phase: RunPhase): ClassifiedPhaseError {
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (isAecError(error, AEC_ERROR.agentCapacityUnavailable)) {
    return { category: "agent_capacity", code: error.code, message };
  }
  if (isAecError(error, AEC_ERROR.runtimeAuthorityViolation)) {
    return { category: "runtime_authority", code: error.code, message };
  }
  if (phase === "review" && isAecError(error, AEC_ERROR.reviewerWorkspaceModified)) {
    return { category: "reviewer_mutation", code: error.code, message };
  }
  if (phase === "remote_checks" && isAecError(error, AEC_ERROR.githubChecksFailed)) {
    return { category: "github_checks", code: error.code, message };
  }
  return { category: "unclassified", ...(isAecError(error) ? { code: error.code } : {}), message };
}

