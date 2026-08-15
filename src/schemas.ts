import { writeJsonAtomic } from "./files.js";

export const workerResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "notes", "blocker"],
  properties: {
    status: { type: "string", enum: ["complete", "blocked"] },
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    blocker: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "question"],
      properties: {
        kind: { type: "string", enum: ["technical", "architecture", "product", "tradeoff"] },
        question: { type: "string" },
      },
    },
  },
} as const;

export const reviewResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary", "file", "line", "requiredChange"],
        properties: {
          severity: { type: "string", enum: ["blocking", "warning"] },
          summary: { type: "string" },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"], minimum: 1 },
          requiredChange: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export function writeSchemas(runDir: string): { worker: string; review: string } {
  const worker = `${runDir}/worker-result.schema.json`;
  const review = `${runDir}/review-result.schema.json`;
  writeJsonAtomic(worker, workerResultSchema);
  writeJsonAtomic(review, reviewResultSchema);
  return { worker, review };
}
