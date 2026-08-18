/**
 * Tests for cli/errorHandling.ts.
 *
 * This logic used to live only inside cli/index.ts's CodingAgentCLI
 * class as module-level process.on(...) calls. That whole file was
 * never actually imported by the real CLI entry point (bin/run.js calls
 * @oclif/core's execute() directly; it discovers commands via
 * package.json's oclif.commands directory scan and never imports
 * cli/index.ts) — so these handlers were never installed in the real
 * running process at all. Moved here and wired into bin/run.js (the
 * actual entry point) instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatFatalError, installGlobalErrorHandlers } from "../../src/cli/errorHandling.js";

describe("formatFatalError", () => {
  it("includes the error message", () => {
    const output = formatFatalError(new Error("something broke"));
    expect(output).toContain("something broke");
  });

  it("includes a System Error header", () => {
    const output = formatFatalError(new Error("x"));
    expect(output).toContain("System Error");
  });

  it("adds an Ollama recommendation for ECONNREFUSED errors", () => {
    const output = formatFatalError(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
    expect(output).toContain("Ollama");
  });

  it("adds an Ollama recommendation for 'fetch failed' errors", () => {
    const output = formatFatalError(new Error("fetch failed"));
    expect(output).toContain("Ollama");
  });

  it("does not add the Ollama recommendation for unrelated errors", () => {
    const output = formatFatalError(new Error("out of memory"));
    expect(output).not.toContain("Ollama");
  });
});

describe("installGlobalErrorHandlers", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("registers an uncaughtException handler that prints and exits(1)", () => {
    installGlobalErrorHandlers();
    process.emit("uncaughtException", new Error("boom"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("registers an unhandledRejection handler that prints and exits(1) for a real Error", () => {
    installGlobalErrorHandlers();
    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("rejected"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("wraps a non-Error rejection reason in an Error before formatting", () => {
    installGlobalErrorHandlers();
    process.emit("unhandledRejection", "a plain string reason", Promise.resolve());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a plain string reason"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
