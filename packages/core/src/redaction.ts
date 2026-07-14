const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(?:access|refresh|id)_token["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/gi,
  /(?:api[_-]?key|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/=-]{12,}/gi,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}/g
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function redactText(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input).replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
}

export function redactJson<T>(value: T): T {
  return visit(value) as T;
}

function visit(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(visit);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = visit(child);
      }
    }
    return out;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  if (key === "noSecrets") return false;
  if (/^(tokenExpiresAt|tokenExpiresAtEEST)$/i.test(key)) return false;
  return /token|secret|password|apiKey|api_key|cookie|credential|authBlob|refresh/i.test(key);
}
