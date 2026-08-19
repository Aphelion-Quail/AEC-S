const MAX_RUNTIME_PAYLOAD_BYTES = 8 * 1024 * 1024;

function balancedObjects(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return candidates;
}

export function parseRuntimeJsonObject(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_RUNTIME_PAYLOAD_BYTES) {
    throw new Error("Runtime structured result exceeds 8 MiB");
  }
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]?.trim() ?? "");
  }
  candidates.push(...balancedObjects(trimmed));
  // ACP streams can contain more than one assistant text segment. The last
  // complete JSON object is the Runtime's final answer; earlier objects may be
  // tool narration or examples emitted while the Turn is still progressing.
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Try the preceding bounded representation of the final response.
    }
  }
  throw new Error("Runtime final response did not contain one JSON object");
}
