/**
 * Scrubs secret-shaped values out of tool output before it re-enters the
 * LLM conversation. Deliberately narrow (shape-based, not a full SECRET_REF
 * indirection architecture) — closes the gap where e.g. a shell command
 * that prints `.env` contents or `AWS_SECRET_ACCESS_KEY=...` would otherwise
 * flow straight into context unredacted.
 */

// Any identifier=value or identifier: value pair with a long-ish value —
// whether it's actually sensitive is decided by isSensitiveKeyName() below,
// not by this capture shape alone.
const KEY_VALUE_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*['"]?([\w.\-+/]{8,})['"]?/g;

// Non-sensitive key qualifiers commonly encountered in dev/data/schemas/crypto
const NON_SENSITIVE_PARTS = new Set([
  "public",
  "foreign",
  "primary",
  "cache",
  "sort",
  "partition",
  "search",
  "routing",
]);

// Single terms that definitively denote credentials or API secrets
const SENSITIVE_TERMS = new Set([
  "apikey",
  "secret",
  "token",
  "credential",
  "credentials",
]);

// Compound modifiers that denote secret keys when combined with "key"
const SENSITIVE_KEY_MODIFIERS = new Set(["api", "access", "private", "auth"]);

export function isSensitiveKeyName(key: string): boolean {
  // Split on underscores/hyphens and true camelCase boundaries (lowercase
  // followed by uppercase) — NOT before every capital, which would shred an
  // all-caps identifier like AWS_SECRET_ACCESS_KEY into single letters.
  const parts = key
    .split(/[_-]+|(?<=[a-z])(?=[A-Z])/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);

  if (parts.some((p) => NON_SENSITIVE_PARTS.has(p))) {
    return false;
  }

  if (parts.some((p) => SENSITIVE_TERMS.has(p))) {
    return true;
  }

  if (parts.includes("key")) {
    return parts.some((p) => SENSITIVE_KEY_MODIFIERS.has(p));
  }

  return false;
}

// Bare secret-shaped tokens with no surrounding key= context.
const BARE_TOKEN_PATTERNS: RegExp[] = [
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Common vendor bearer-token prefixes (OpenAI/Anthropic/Groq/GitHub/Stripe-style)
  /\b(?:sk-|gsk_|ghp_|pk_(?:live|test)_)[A-Za-z0-9_-]{20,}\b/g,
  // Authorization headers
  /\bBearer\s+[\w.-]{20,}\b/gi,
];

export function scrubSecrets(text: string): string {
  if (!text) return text;

  let result = text.replace(KEY_VALUE_PATTERN, (match, key: string) =>
    isSensitiveKeyName(key) ? `${key}=***REDACTED***` : match,
  );

  for (const pattern of BARE_TOKEN_PATTERNS) {
    result = result.replace(pattern, "***REDACTED***");
  }

  return result;
}
