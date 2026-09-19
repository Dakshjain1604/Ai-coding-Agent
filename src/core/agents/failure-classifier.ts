/**
 * Failure Classifier — architecture-optimal.md Phase 3 item 18, scoped to
 * what this codebase actually has a retry loop for: LLM provider-call
 * failures (UniversalAgent's per-iteration callLLM retry), not the doc's
 * broader code-level failure taxonomy (syntax/type/test/dependency/...),
 * which belongs to a build/test pipeline this project doesn't run mid-loop.
 *
 * The concrete bug this fixes: the retry loop previously treated every
 * error identically — 3 blind exponential-backoff retries of the exact
 * same request. That's pointless (and wastes real wall-clock time) for
 * errors that can never succeed on retry, like a 413 payload-too-large —
 * confirmed live: a Groq free-tier request over its TPM limit fails the
 * same way every time until the request itself shrinks. Non-retryable
 * failures now skip straight to dynamic fallback (a different
 * provider/model may genuinely help) instead of sleeping and repeating a
 * doomed request.
 */

export type FailureCategory =
  | "quota_exhausted"
  | "invalid_model_output"
  | "context_overflow"
  | "rate_limit"
  | "payload_too_large"
  | "auth"
  | "not_found"
  | "server_error"
  | "network"
  | "invalid_request"
  | "internal_error"
  | "unknown";

export interface ClassifiedFailure {
  category: FailureCategory;
  /** Worth retrying the identical request as-is (transient conditions). */
  retryable: boolean;
  /** Worth trying a different provider/model instead of the same request. */
  shouldChangeStrategy: boolean;
  reason: string;
}

interface StatusCarryingError {
  status?: number;
  statusCode?: number;
  details?: { status?: number; error?: { status?: number } };
}

function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const err = error as StatusCarryingError;
  return err.status ?? err.statusCode ?? err.details?.status ?? err.details?.error?.status;
}

function classifyByStatus(status: number): ClassifiedFailure | undefined {
  if (status === 413) {
    return {
      category: "payload_too_large",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "HTTP 413 — request payload exceeds a hard limit; identical retries fail the same way every time.",
    };
  }
  if (status === 429) {
    return {
      category: "rate_limit",
      retryable: true,
      shouldChangeStrategy: false,
      reason: "HTTP 429 — rate limited; worth a backoff retry, the limit window may clear.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: "auth",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "HTTP 401/403 — authentication/authorization failure; the same credentials will not succeed on retry.",
    };
  }
  if (status === 404) {
    return {
      category: "not_found",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "HTTP 404 — requested model/endpoint not found; not a transient condition.",
    };
  }
  if (status >= 500 && status < 600) {
    return {
      category: "server_error",
      retryable: true,
      shouldChangeStrategy: false,
      reason: `HTTP ${status} — server-side error, often transient.`,
    };
  }
  if (status === 400) {
    return {
      category: "invalid_request",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "HTTP 400 — malformed request; identical retries fail the same way every time.",
    };
  }
  return undefined;
}

// Ordered most-specific-first — payload/rate-limit phrasing frequently
// includes a bare "429"/"413" digit sequence that would otherwise get
// mis-bucketed by a generic 4xx/5xx scan, so those patterns are checked
// ahead of any broad numeric-status fallback.
const MESSAGE_PATTERNS: Array<{
  test: RegExp;
  classify: () => ClassifiedFailure;
}> = [
  {
    test: /\b413\b|payload too large|request too large|too many tokens|context length exceeded|maximum context length/i,
    classify: () => ({
      category: "payload_too_large",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "Request payload/context exceeds a hard limit — retrying identically will fail the same way every time.",
    }),
  },
  {
    test: /\b429\b|rate.?limit|too many requests|tokens per minute|requests per minute|quota exceeded/i,
    classify: () => ({
      category: "rate_limit",
      retryable: true,
      shouldChangeStrategy: false,
      reason: "Rate limited — worth a backoff retry, the limit window may clear on its own.",
    }),
  },
  {
    test: /\b401\b|\b403\b|unauthorized|invalid api key|authentication fail|forbidden/i,
    classify: () => ({
      category: "auth",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "Authentication/authorization failure — retrying with the same credentials will not help.",
    }),
  },
  {
    test: /\b404\b|model not found|does not exist|no such model|unknown model/i,
    classify: () => ({
      category: "not_found",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "Requested model/resource not found — the model name or endpoint is wrong, not transient.",
    }),
  },
  {
    test: /\b5\d{2}\b|internal server error|service unavailable|bad gateway|gateway timeout/i,
    classify: () => ({
      category: "server_error",
      retryable: true,
      shouldChangeStrategy: false,
      reason: "Server-side error — often transient, worth a retry.",
    }),
  },
  {
    test: /econnrefused|econnreset|etimedout|enotfound|fetch failed|network error|socket hang up|timed? ?out/i,
    classify: () => ({
      category: "network",
      retryable: true,
      shouldChangeStrategy: false,
      reason: "Network-level failure — worth retrying, may be transient connectivity.",
    }),
  },
  {
    test: /\b400\b|bad request|invalid request|malformed/i,
    classify: () => ({
      category: "invalid_request",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "Malformed request — retrying identically will fail the same way every time.",
    }),
  },
];

/**
 * Classifies an error caught from a provider call. Checks a structured
 * HTTP status code first when the underlying error carries one (some
 * providers thread the original SDK error through, e.g. OpenAIProvider's
 * `{ error }` detail; others, e.g. GroqProvider, only pass a message
 * string) — falls back to message-pattern matching either way, since
 * every provider's wrapped error message embeds the underlying status/
 * phrase as text regardless of whether the original object survives.
 */
// Native JS runtime error types indicate a bug in our own request-building
// code, not a remote/API condition — retrying (same provider) or falling
// back (different provider) both hit the identical bug, so neither helps.
const INTERNAL_ERROR_NAMES = new Set([
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
]);

/**
 * An exhausted account quota (daily free-model cap, no credits, billing
 * limit) often arrives as HTTP 429 — the same status as a transient rate
 * limit — but no amount of backoff clears it within a task. Confirmed live:
 * OpenRouter's "free-models-per-day" 429 was retried 9 times per call before
 * the task failed. Checked ahead of the status-code mapping for that reason.
 */
const QUOTA_EXHAUSTED_PATTERN =
  /per-day|per day|daily (?:limit|quota)|insufficient (?:credits|funds|balance)|credit balance|exceeded your current quota/i;

/**
 * Signals that a limit is a short rolling window, whatever else the message
 * says. Confirmed live: Groq's per-minute 429 ends with an upsell link to
 * ".../settings/billing" — keyword-matching that as an exhausted quota made
 * a 4-second wait fatal. A stated retry time is authoritative.
 */
const SHORT_WINDOW_PATTERN = /per minute|\b[TR]PM\b|try again in \d/i;

/**
 * The provider rejected what the MODEL generated (malformed tool-call JSON,
 * schema-violating arguments) — sometimes reported as HTTP 400, but unlike a
 * malformed request from our side, a fresh sample usually succeeds.
 * Confirmed live on Groq: "Failed to parse tool call arguments as JSON",
 * error code "tool_use_failed".
 */
/**
 * The prompt no longer fits the model's context window. Distinct from a 413
 * over a per-minute token limit (payload_too_large): here the conversation
 * itself must shrink. OpenAI reports it as a 400 (code
 * context_length_exceeded), so it is matched ahead of the status mapping.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context_length_exceeded|maximum context length|context length (?:exceeded|is)|context window|prompt is too long|input is too long|reduce the length of the (?:messages|input|prompt)/i;

const INVALID_MODEL_OUTPUT_PATTERN =
  /tool_use_failed|failed to parse tool call|tool call validation failed|did not call a tool/i;

export function classifyFailure(error: unknown): ClassifiedFailure {
  const status = extractStatusCode(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  if (CONTEXT_OVERFLOW_PATTERN.test(rawMessage) && !SHORT_WINDOW_PATTERN.test(rawMessage)) {
    return {
      category: "context_overflow",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "The prompt exceeds the model's context window — the conversation must be shortened before retrying.",
    };
  }
  if (INVALID_MODEL_OUTPUT_PATTERN.test(rawMessage)) {
    return {
      category: "invalid_model_output",
      retryable: true,
      shouldChangeStrategy: false,
      reason: "The provider rejected the model's generated output (e.g. malformed tool-call JSON) — a fresh sample usually succeeds.",
    };
  }
  if (status === 402 || (QUOTA_EXHAUSTED_PATTERN.test(rawMessage) && !SHORT_WINDOW_PATTERN.test(rawMessage))) {
    return {
      category: "quota_exhausted",
      retryable: false,
      shouldChangeStrategy: true,
      reason: "Account quota or credit exhausted — retrying cannot succeed until the quota resets or credit is added.",
    };
  }
  if (status !== undefined) {
    const byStatus = classifyByStatus(status);
    if (byStatus) return byStatus;
  }

  // Checked before message-pattern matching (like structured status codes)
  // — error.name is a structural signal, more reliable than scanning text
  // that might coincidentally contain an unrelated number or phrase.
  if (error instanceof Error && INTERNAL_ERROR_NAMES.has(error.name)) {
    return {
      category: "internal_error",
      retryable: false,
      shouldChangeStrategy: false,
      reason: `${error.name} indicates a bug in request-building code, not a remote/API condition — retrying or switching providers both hit the identical bug.`,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  for (const { test, classify } of MESSAGE_PATTERNS) {
    if (test.test(message)) return classify();
  }

  return {
    category: "unknown",
    retryable: true,
    shouldChangeStrategy: false,
    reason: "Unrecognized error shape — defaulting to a bounded retry rather than failing immediately.",
  };
}
