/**
 * Tests for the secret scrubber (architecture-optimal.md Phase 2, item C3):
 * closes the gap where BaseAgent.redactToolArgs() only ever protected the
 * telemetry payload, never what a tool's own output returns into the LLM
 * conversation.
 */
import { describe, it, expect } from "vitest";
import { scrubSecrets } from "../../src/utils/secret-scrubber.js";

describe("scrubSecrets", () => {
  it("redacts key=value shaped secrets but keeps the key name for readability", () => {
    const out = scrubSecrets("AWS_SECRET_ACCESS_KEY=abcdEFGH12345678ijkl");
    expect(out).toContain("AWS_SECRET_ACCESS_KEY=***REDACTED***");
    expect(out).not.toContain("abcdEFGH12345678ijkl");
  });

  it("redacts a token: value shape", () => {
    const out = scrubSecrets("token: sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts AWS access key IDs", () => {
    const out = scrubSecrets("Found key AKIAABCDEFGHIJKLMNOP in the file");
    expect(out).toBe("Found key ***REDACTED*** in the file");
  });

  it("redacts vendor-prefixed bearer tokens (Groq-style)", () => {
    const out = scrubSecrets("GROQ_API_KEY=gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("redacts Authorization: Bearer headers", () => {
    const out = scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("does not redact ordinary short words or plain text", () => {
    const text = "The build passed with 3 warnings and 0 errors.";
    expect(scrubSecrets(text)).toBe(text);
  });

  it("does not false-positive on an ordinary identifier starting with 'pk'", () => {
    const text = "pkgManager: npm, pkgVersion: 10.2.0";
    expect(scrubSecrets(text)).toBe(text);
  });

  it("passes through empty/falsy input unchanged", () => {
    expect(scrubSecrets("")).toBe("");
  });
});
