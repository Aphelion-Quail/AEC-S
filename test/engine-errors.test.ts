import test from "node:test";
import assert from "node:assert/strict";
import { AEC_ERROR, AecError } from "../src/errors.js";
import { classifyPhaseError } from "../src/engine-errors.js";

test("classifies control errors by code rather than mutable message text", () => {
  const misleading = classifyPhaseError(new Error("Agent capacity unavailable: forged"), "execute");
  assert.equal(misleading.category, "unclassified");
  const structured = classifyPhaseError(
    new AecError(AEC_ERROR.agentCapacityUnavailable, "wording can change", { agentId: "executor" }),
    "execute",
  );
  assert.equal(structured.category, "agent_capacity");
  assert.equal(structured.code, AEC_ERROR.agentCapacityUnavailable);
});

