const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY))\s*=\s*([^\s,;]+)/gi,
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

export function redactText(value: string, maxLength = 4_000): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, key: string | undefined) =>
      key && /(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)/i.test(key) ? `${key}=[REDACTED]` : "[REDACTED]",
    );
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…[truncated]` : result;
}

export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child)])) as T;
  }
  return value;
}
