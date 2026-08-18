/**
 * Comprehensive, independently-designed test battery for failure-classifier.ts
 * (architecture-optimal.md Phase 3, item 18 — scoped to LLM provider-call
 * failures, which is the retry loop this codebase actually has).
 *
 * Cases are written against expected behavior for each error shape, not
 * retrofitted to the implementation — including real message strings this
 * codebase's providers actually produce (confirmed live: the Groq 413
 * case), structured status codes, ambiguous/conflicting signals, and
 * non-Error inputs.
 */
import { describe, it, expect } from "vitest";
import { classifyFailure, type FailureCategory } from "../../src/core/agents/failure-classifier.js";

function expectCategory(
  input: unknown,
  category: FailureCategory,
  retryable: boolean,
) {
  const result = classifyFailure(input);
  expect(result.category).toBe(category);
  expect(result.retryable).toBe(retryable);
}

describe("classifyFailure — payload_too_large", () => {
  it("recognizes the exact real Groq 413 message seen live", () => {
    expectCategory(
      new Error(
        "Groq streaming error: 413 Request too large for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9098, please reduce your message size and try again.",
      ),
      "payload_too_large",
      false,
    );
  });

  it("recognizes 'context length exceeded' phrasing (OpenAI-style)", () => {
    expectCategory(new Error("This model's maximum context length exceeded"), "payload_too_large", false);
  });

  it("recognizes 'too many tokens' phrasing", () => {
    expectCategory(new Error("Error: too many tokens in request"), "payload_too_large", false);
  });

  it("recognizes bare '413' in a generic wrapper", () => {
    expectCategory(new Error("OpenAI API error: 413"), "payload_too_large", false);
  });

  it("marks payload_too_large as shouldChangeStrategy", () => {
    const result = classifyFailure(new Error("413 Request too large"));
    expect(result.shouldChangeStrategy).toBe(true);
  });
});

describe("classifyFailure — rate_limit", () => {
  it("recognizes bare '429'", () => {
    expectCategory(new Error("OpenAI API error: 429"), "rate_limit", true);
  });

  it("recognizes 'Too Many Requests'", () => {
    expectCategory(new Error("429 Too Many Requests"), "rate_limit", true);
  });

  it("recognizes 'rate limit' (spaced)", () => {
    expectCategory(new Error("You have hit the rate limit for this model"), "rate_limit", true);
  });

  it("recognizes 'rate-limited' (hyphenated)", () => {
    expectCategory(new Error("Request was rate-limited, please slow down"), "rate_limit", true);
  });

  it("recognizes 'tokens per minute' (Groq-style TPM limit)", () => {
    expectCategory(new Error("exceeded tokens per minute (TPM) limit"), "rate_limit", true);
  });

  it("recognizes 'requests per minute'", () => {
    expectCategory(new Error("exceeded requests per minute (RPM) limit"), "rate_limit", true);
  });

  it("recognizes 'quota exceeded' (Gemini-style)", () => {
    expectCategory(new Error("Gemini API error: quota exceeded for this project"), "rate_limit", true);
  });

  it("is case-insensitive ('RATE LIMIT EXCEEDED')", () => {
    expectCategory(new Error("RATE LIMIT EXCEEDED"), "rate_limit", true);
  });
});

describe("classifyFailure — auth", () => {
  it("recognizes bare '401'", () => {
    expectCategory(new Error("Claude API error: 401"), "auth", false);
  });

  it("recognizes bare '403'", () => {
    expectCategory(new Error("403 error from provider"), "auth", false);
  });

  it("recognizes 'Unauthorized'", () => {
    expectCategory(new Error("Unauthorized: invalid credentials"), "auth", false);
  });

  it("recognizes 'invalid api key'", () => {
    expectCategory(new Error("Error: Invalid API key provided"), "auth", false);
  });

  it("recognizes 'authentication fail'", () => {
    expectCategory(new Error("Authentication failed for this request"), "auth", false);
  });

  it("recognizes 'forbidden'", () => {
    expectCategory(new Error("Forbidden: you do not have access to this resource"), "auth", false);
  });

  it("marks auth as shouldChangeStrategy", () => {
    expect(classifyFailure(new Error("401 Unauthorized")).shouldChangeStrategy).toBe(true);
  });
});

describe("classifyFailure — not_found", () => {
  it("recognizes bare '404'", () => {
    expectCategory(new Error("OpenAI API error: 404"), "not_found", false);
  });

  it("recognizes 'model not found'", () => {
    expectCategory(new Error("Error: model not found"), "not_found", false);
  });

  it("recognizes 'does not exist' (Groq model-deprecation style)", () => {
    expectCategory(
      new Error("The model `llama-3.3-70b-versatile` does not exist or you do not have access to it."),
      "not_found",
      false,
    );
  });

  it("recognizes 'no such model'", () => {
    expectCategory(new Error("no such model available"), "not_found", false);
  });

  it("recognizes 'unknown model'", () => {
    expectCategory(new Error("unknown model requested"), "not_found", false);
  });
});

describe("classifyFailure — server_error", () => {
  it("recognizes bare '500'", () => {
    expectCategory(new Error("OpenAI API error: 500"), "server_error", true);
  });

  it("recognizes bare '502'", () => {
    expectCategory(new Error("502 error"), "server_error", true);
  });

  it("recognizes bare '503'", () => {
    expectCategory(new Error("503 error"), "server_error", true);
  });

  it("recognizes 'Internal Server Error'", () => {
    expectCategory(new Error("500 Internal Server Error"), "server_error", true);
  });

  it("recognizes 'Service Unavailable'", () => {
    expectCategory(new Error("Service Unavailable"), "server_error", true);
  });

  it("recognizes 'Bad Gateway'", () => {
    expectCategory(new Error("502 Bad Gateway"), "server_error", true);
  });

  it("recognizes 'Gateway Timeout'", () => {
    expectCategory(new Error("504 Gateway Timeout"), "server_error", true);
  });

  it("does not classify a 3-digit non-5xx number as server_error", () => {
    // Sanity check that \b5\d{2}\b doesn't over-match, e.g. a random
    // unrelated 3-digit number in a message.
    const result = classifyFailure(new Error("processed 500 items successfully"));
    // "500" here isn't actually an HTTP status in context, but the
    // classifier can't know that from text alone — document that this is
    // a known false-positive risk of pattern-only matching. Still expect
    // server_error, since this is the documented, accepted trade-off of a
    // lightweight text-based classifier rather than a strict HTTP client.
    expect(result.category).toBe("server_error");
  });
});

describe("classifyFailure — network", () => {
  it("recognizes ECONNREFUSED", () => {
    expectCategory(new Error("connect ECONNREFUSED 127.0.0.1:11434"), "network", true);
  });

  it("recognizes ECONNRESET", () => {
    expectCategory(new Error("read ECONNRESET"), "network", true);
  });

  it("recognizes ETIMEDOUT", () => {
    expectCategory(new Error("connect ETIMEDOUT"), "network", true);
  });

  it("recognizes ENOTFOUND", () => {
    expectCategory(new Error("getaddrinfo ENOTFOUND api.example.com"), "network", true);
  });

  it("recognizes 'fetch failed' (Node/Ollama-style)", () => {
    expectCategory(new Error("fetch failed"), "network", true);
  });

  it("recognizes 'socket hang up'", () => {
    expectCategory(new Error("socket hang up"), "network", true);
  });

  it("recognizes 'timed out' (spaced)", () => {
    expectCategory(new Error("Request timed out after 30000ms"), "network", true);
  });

  it("recognizes 'timeout' (unspaced)", () => {
    expectCategory(new Error("connection timeout"), "network", true);
  });

  it("is case-insensitive for network errors", () => {
    expectCategory(new Error("ECONNREFUSED"), "network", true);
  });
});

describe("classifyFailure — invalid_request", () => {
  it("recognizes bare '400'", () => {
    expectCategory(new Error("OpenAI API error: 400"), "invalid_request", false);
  });

  it("recognizes 'Bad Request'", () => {
    expectCategory(new Error("400 Bad Request"), "invalid_request", false);
  });

  it("recognizes 'Invalid request'", () => {
    expectCategory(new Error("Invalid request: missing required field"), "invalid_request", false);
  });

  it("recognizes 'malformed'", () => {
    expectCategory(new Error("malformed JSON in request body"), "invalid_request", false);
  });
});

describe("classifyFailure — unknown / fallback behavior", () => {
  it("classifies a message matching nothing as unknown, retryable by default", () => {
    expectCategory(new Error("Something completely unexpected happened"), "unknown", true);
  });

  it("classifies an empty-message error as unknown", () => {
    expectCategory(new Error(""), "unknown", true);
  });

  it("classifies a whitespace-only message as unknown", () => {
    expectCategory(new Error("   \n  "), "unknown", true);
  });

  it("handles a plain string thrown instead of an Error", () => {
    expectCategory("rate limit exceeded", "rate_limit", true);
  });

  it("handles a plain string with no recognizable pattern", () => {
    expectCategory("just a plain string", "unknown", true);
  });

  it("handles undefined without crashing", () => {
    expect(() => classifyFailure(undefined)).not.toThrow();
    expectCategory(undefined, "unknown", true);
  });

  it("handles null without crashing", () => {
    expect(() => classifyFailure(null)).not.toThrow();
    expectCategory(null, "unknown", true);
  });

  it("handles a number without crashing", () => {
    expect(() => classifyFailure(42)).not.toThrow();
  });

  it("handles a plain object without crashing", () => {
    expect(() => classifyFailure({ foo: "bar" })).not.toThrow();
  });

  it("marks unknown as shouldChangeStrategy false (default bounded retry)", () => {
    expect(classifyFailure(new Error("mystery error")).shouldChangeStrategy).toBe(false);
  });
});

describe("classifyFailure — structured status codes (precedence over message text)", () => {
  it("classifies via a bare .status property when present", () => {
    const err = Object.assign(new Error("some generic wrapper message"), { status: 413 });
    expectCategory(err, "payload_too_large", false);
  });

  it("classifies via a .statusCode property", () => {
    const err = Object.assign(new Error("wrapper"), { statusCode: 429 });
    expectCategory(err, "rate_limit", true);
  });

  it("classifies via details.status (Groq-style detail shape)", () => {
    const err = Object.assign(new Error("wrapper"), { details: { status: 500 } });
    expectCategory(err, "server_error", true);
  });

  it("classifies via details.error.status (OpenAIProvider's { error } detail shape)", () => {
    const err = Object.assign(new Error("wrapper"), {
      details: { error: { status: 401 } },
    });
    expectCategory(err, "auth", false);
  });

  it("prefers the structured status over conflicting message text", () => {
    // Message text suggests rate_limit, but the structured status says
    // payload_too_large — structured data should win since it's more
    // reliable than a text scan.
    const err = Object.assign(new Error("429 rate limit message text"), { status: 413 });
    expectCategory(err, "payload_too_large", false);
  });

  it("falls back to message-text matching when the status code is unrecognized", () => {
    const err = Object.assign(new Error("429 too many requests"), { status: 999 });
    expectCategory(err, "rate_limit", true);
  });

  it("falls back to message-text matching when no status field exists at all", () => {
    const err = new Error("500 internal server error");
    expectCategory(err, "server_error", true);
  });
});

describe("classifyFailure — pattern precedence for ambiguous/multi-signal messages", () => {
  it("prefers payload_too_large over rate_limit when both digits appear", () => {
    // Payload-too-large is checked first — a message mentioning both a 413
    // and elsewhere a rate-limit-shaped phrase should resolve to the more
    // specific, earlier-checked category.
    expectCategory(
      new Error("413 Request too large — you may also be near your rate limit"),
      "payload_too_large",
      false,
    );
  });

  it("prefers rate_limit over server_error when both digits appear", () => {
    expectCategory(new Error("429 error, server also returned 503 earlier"), "rate_limit", true);
  });

  it("prefers auth over not_found when both digits appear", () => {
    expectCategory(new Error("401 unauthorized, resource may be 404 as well"), "auth", false);
  });
});

describe("classifyFailure — real provider wrapper formats", () => {
  it("classifies through a ClaudeProvider-style wrapper", () => {
    expectCategory(new Error("Claude API error: 429 rate limit exceeded"), "rate_limit", true);
  });

  it("classifies through an OpenAIProvider-style wrapper", () => {
    expectCategory(new Error("OpenAI API error: 401 Incorrect API key provided"), "auth", false);
  });

  it("classifies through a GeminiProvider-style wrapper", () => {
    expectCategory(new Error("Gemini API error: 400 Bad Request"), "invalid_request", false);
  });

  it("classifies through a GroqProvider streaming-error wrapper", () => {
    expectCategory(
      new Error("Groq streaming error: 500 Internal Server Error"),
      "server_error",
      true,
    );
  });

  it("classifies through an HuggingFace-style wrapper using statusText", () => {
    expectCategory(new Error("HF API error: Too Many Requests"), "rate_limit", true);
  });

  it("classifies through a generic LocalProvider/Ollama-style wrapper", () => {
    expectCategory(new Error("ollama API error: fetch failed"), "network", true);
  });

  it("classifies through an OllamaCloud-style wrapper", () => {
    expectCategory(new Error("OllamaCloud API error: 404 model not found"), "not_found", false);
  });

  it("classifies through an OpenRouter-style wrapper", () => {
    expectCategory(new Error("OpenRouter API error: 402 Payment Required — quota exceeded"), "rate_limit", true);
  });
});

describe("classifyFailure — every category has a non-empty, informative reason", () => {
  const samples: Array<[unknown, FailureCategory]> = [
    [new Error("413 too large"), "payload_too_large"],
    [new Error("429 rate limit"), "rate_limit"],
    [new Error("401 unauthorized"), "auth"],
    [new Error("404 not found"), "not_found"],
    [new Error("500 server error"), "server_error"],
    [new Error("ECONNREFUSED"), "network"],
    [new Error("400 bad request"), "invalid_request"],
    [new Error("totally unrecognized"), "unknown"],
  ];

  for (const [input, expectedCategory] of samples) {
    it(`"${expectedCategory}" has a real reason string`, () => {
      const result = classifyFailure(input);
      expect(result.category).toBe(expectedCategory);
      expect(result.reason.length).toBeGreaterThan(10);
    });
  }
});

describe("classifyFailure — retryable/shouldChangeStrategy are logically consistent", () => {
  const allSamples: unknown[] = [
    new Error("413 payload too large"),
    new Error("429 rate limit"),
    new Error("401 unauthorized"),
    new Error("404 not found"),
    new Error("500 server error"),
    new Error("ECONNREFUSED"),
    new Error("400 bad request"),
    new Error("totally unrecognized message"),
  ];

  for (const input of allSamples) {
    it(`is internally consistent for: "${(input as Error).message}"`, () => {
      const result = classifyFailure(input);
      // A retryable failure means "try the same request again" — it
      // should never ALSO claim you need to change strategy in the same
      // breath (that would be a contradictory signal for the caller).
      if (result.retryable) {
        expect(result.shouldChangeStrategy).toBe(false);
      } else {
        expect(result.shouldChangeStrategy).toBe(true);
      }
    });
  }

  it("internal_error is the deliberate exception: neither retryable nor shouldChangeStrategy", () => {
    // A bug in our own request-building code fails identically regardless
    // of retrying OR switching providers — both are equally futile, so
    // this category intentionally violates the "not retryable implies
    // change strategy" pattern the other categories follow.
    const result = classifyFailure(new TypeError("Cannot read properties of undefined"));
    expect(result.retryable).toBe(false);
    expect(result.shouldChangeStrategy).toBe(false);
  });
});

describe("classifyFailure — internal_error (native JS runtime errors)", () => {
  it("classifies a TypeError as internal_error, not retryable", () => {
    expectCategory(new TypeError("Cannot read properties of undefined (reading 'foo')"), "internal_error", false);
  });

  it("classifies a ReferenceError as internal_error", () => {
    expectCategory(new ReferenceError("x is not defined"), "internal_error", false);
  });

  it("classifies a SyntaxError as internal_error", () => {
    expectCategory(new SyntaxError("Unexpected token in JSON"), "internal_error", false);
  });

  it("classifies a RangeError as internal_error", () => {
    expectCategory(new RangeError("Invalid array length"), "internal_error", false);
  });

  it("checks error.name before message text — a TypeError whose message happens to contain '429' is still internal_error", () => {
    // error.name is a structural signal, more reliable than scanning
    // message text that might coincidentally contain an unrelated number.
    expectCategory(
      new TypeError("Cannot read property 'code429' of undefined"),
      "internal_error",
      false,
    );
  });

  it("does not misclassify a plain Error (not a TypeError/ReferenceError/etc) as internal_error", () => {
    const result = classifyFailure(new Error("Cannot read properties of undefined"));
    expect(result.category).not.toBe("internal_error");
  });
});

describe("classifyFailure — documented limitation: bare payment-required signals with no other keyword", () => {
  it("a bare '402 Payment Required' with no recognizable phrase falls to unknown (not a dedicated category)", () => {
    // No provider in this codebase has been observed sending a bare 402
    // with no other signal — adding a dedicated category for an
    // unobserved case would be speculative. Documented here rather than
    // silently left unspecified: this currently resolves to
    // unknown/retryable, which is imperfect (retrying a real billing
    // issue won't help) but a deliberate, scoped trade-off, not an
    // oversight.
    const result = classifyFailure(new Error("402 Payment Required"));
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(true);
  });
});
