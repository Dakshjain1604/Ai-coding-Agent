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

// A key name counts as sensitive if one of its underscore/camelCase-split
// parts matches one of these terms exactly — this avoids false positives
// like "keyword" or "monkey" while still catching compound names like
// AWS_SECRET_ACCESS_KEY or apiToken.
const SENSITIVE_KEY_PARTS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
]);

function isSensitiveKeyName(key: string): boolean {
  // Split on underscores/hyphens and true camelCase boundaries (lowercase
  // followed by uppercase) — NOT before every capital, which would shred an
  // all-caps identifier like AWS_SECRET_ACCESS_KEY into single letters.
  const parts = key
    .split(/[_-]+|(?<=[a-z])(?=[A-Z])/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  return parts.some((p) => SENSITIVE_KEY_PARTS.has(p));
}

// Bare secret-shaped tokens with no surrounding key= context.
const BARE_TOKEN_PATTERNS: RegExp[] = [
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Common vendor bearer-token prefixes (OpenAI/Anthropic/Groq/GitHub/Stripe-style)
  /\b(?:sk-|gsk_|ghp_|pk_(?:live|test)_)[A-Za-z0-9_-]{20,}\b/g,
  // Authorization headers
  /\bBearer\s+[\w.\-]{20,}\b/gi,
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
