export const REDACTED = '[REDACTED]';

// Keys whose values must never reach the audit table, whatever their nesting depth.
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|email|phone|owner|card|account|iban|ssn|tax|dob|birth/i;
// Values that look like credentials even under an innocent key name.
const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const BEARER = /^Bearer\s+\S+/i;

const MAX_DEPTH = 5;
const MAX_STRING = 500;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (JWT_LIKE.test(value) || BEARER.test(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') return redactMetadata(value as Record<string, unknown>, depth + 1);
  return value;
}

/** Returns a copy of `metadata` with sensitive keys masked and credential-looking values removed. */
export function redactMetadata(metadata: Record<string, unknown>, depth = 0): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, depth)]),
  );
}
