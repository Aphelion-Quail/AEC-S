import type { Agent, AgentRole, RunPhase } from "./types.js";

const CAPACITY_PHASES = new Set<RunPhase>(["prepare", "execute", "validate", "review", "repair", "publish"]);
const CONTROL_PHASES = new Set<RunPhase>([
  "prepare",
  "publish",
  "remote_checks",
  "merge",
  "post_merge_smoke",
  "stability_observation",
  "revert",
]);
const EVIDENCE_BEARING_PHASES = new Set<RunPhase>(["validate", "review", "repair", "publish", "remote_checks", "merge"]);

export function occupiesRuntimeCapacity(phase: RunPhase): boolean {
  return CAPACITY_PHASES.has(phase);
}

export function isControlPhase(phase: RunPhase): boolean {
  return CONTROL_PHASES.has(phase);
}

export function bearsRevisionEvidence(phase: RunPhase): boolean {
  return EVIDENCE_BEARING_PHASES.has(phase);
}

export function selectDeterministicAgent(input: {
  agents: Agent[];
  role: AgentRole;
  capabilities: string[];
  excluded: Set<string>;
  excludedFamilies: Set<string>;
  loadOverride?: Map<string, number>;
}): Agent | undefined {
  const { agents, role, capabilities, excluded, excludedFamilies, loadOverride } = input;
  const compare = (left: Agent, right: Agent): number => {
    const loadDelta =
      (loadOverride?.get(left.id) ?? left.currentLoad) / left.maxConcurrency -
      (loadOverride?.get(right.id) ?? right.currentLoad) / right.maxConcurrency;
    if (loadDelta !== 0) return loadDelta;
    const assignmentDelta =
      Date.parse(left.lastAssignedAt ?? "1970-01-01T00:00:00.000Z") -
      Date.parse(right.lastAssignedAt ?? "1970-01-01T00:00:00.000Z");
    if (assignmentDelta !== 0) return assignmentDelta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  };
  let selected: Agent | undefined;
  for (const agent of agents) {
    if (!agent.enabled || agent.availability !== "available" || !agent.roles.includes(role) ||
        (agent.adapter !== "command" && agent.runtimeCapabilities?.structuredOutput !== true) ||
        (role === "reviewer" && agent.adapter !== "command" && agent.runtimeCapabilities?.reviewMode !== true) ||
        (loadOverride?.get(agent.id) ?? agent.currentLoad) >= agent.maxConcurrency ||
        excluded.has(agent.id) || excludedFamilies.has(agent.runtimeFamily ?? agent.adapter) ||
        !capabilities.every((capability) => agent.capabilities.includes(capability))) continue;
    if (!selected || compare(agent, selected) < 0) selected = agent;
  }
  return selected;
}
