type SecretPattern = readonly [RegExp, string | ((...args: string[]) => string)];

const SECRET_PATTERNS: SecretPattern[] = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "[REDACTED]"],
  [
    /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY))\s*=\s*(["'])(.*?)\2/gi,
    (_match: string, key: string) => `${key}=[REDACTED]`,
  ],
  [
    /\b([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY))\s*=\s*([^\s,;"']+)/gi,
    (_match: string, key: string) => `${key}=[REDACTED]`,
  ],
  [
    /(["']?)([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY))\1\s*:\s*(["'])([^"'\r\n]+)\3/gi,
    (_match: string, quote: string, key: string, valueQuote: string) => `${quote}${key}${quote}: ${valueQuote}[REDACTED]${valueQuote}`,
  ],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, "[REDACTED]"],
];

const SECRET_KEY_PATTERN = /(?:^|_)(?:access_token|refresh_token|session_token|auth_token|auth|authorization|password|secret|api_key|private_key|credential|token)(?:$|_)/i;

export function isSecretKey(key: string): boolean {
  if (/^(?:tokenUsage|inputTokens|outputTokens|totalTokens)$/i.test(key)) return false;
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  return SECRET_KEY_PATTERN.test(normalized);
}

export function redactText(value: string, maxLength = 4_000): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement as never);
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…[truncated]` : result;
}

export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      isSecretKey(key) ? "[REDACTED]" : redactJson(child),
    ])) as T;
  }
  return value;
}
