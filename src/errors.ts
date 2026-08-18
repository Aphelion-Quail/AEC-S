export const AEC_ERROR = {
  agentCapacityUnavailable: "agent_capacity_unavailable",
  githubChecksFailed: "github_checks_failed",
  gitFastForwardRequired: "git_fast_forward_required",
  reviewerWorkspaceModified: "reviewer_workspace_modified",
  runLeaseLost: "run_lease_lost",
  runtimeAuthorityViolation: "runtime_authority_violation",
} as const;

export type AecErrorCode = typeof AEC_ERROR[keyof typeof AEC_ERROR];

export class AecError extends Error {
  constructor(
    readonly code: AecErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AecError";
  }
}

export function isAecError(error: unknown, code?: AecErrorCode): error is AecError {
  return error instanceof AecError && (code === undefined || error.code === code);
}

