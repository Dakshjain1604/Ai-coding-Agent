/**
 * Tests for cli/hooks/command-not-found.ts — the oclif command_not_found
 * lifecycle hook.
 *
 * Fixes two real, live-confirmed bugs: `coding-agent -i` and
 * `coding-agent --interactive` (the documented ways to start interactive
 * mode) both hard-failed with "command -i not found" / "command
 * --interactive not found", because cli/index.ts's CodingAgentCLI class
 * (which declared the -i/--interactive flag) was never actually wired
 * into oclif's real command resolution — bin/run.js calls @oclif/core's
 * execute() directly and never imports it. (True bare invocation with
 * zero arguments is a separate, unfixable-via-hook case: oclif's own
 * main.js hard-codes `argv.length === 0 && !isSingleCommandCLI` to
 * always show help before any hook or command resolution runs at all,
 * for every multi-command CLI — the same convention git/npm/docker use.
 * This project already uses multi-command mode for run/debug/test/etc.,
 * so that specific case is intentionally left as-is rather than risking
 * a much bigger, riskier architecture change to "fix" what is actually
 * standard CLI behavior.)
 *
 * Also critical: a command_not_found hook that resolves without
 * throwing counts as "handled" to oclif's runCommand(), regardless of
 * what it returns — so a genuine typo (anything other than empty/-i/
 * --interactive) MUST still throw, or every misspelled command would be
 * silently swallowed into launching interactive mode instead of showing
 * a normal "command not found" error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const startInteractiveModeMock = vi.fn();

vi.mock("../../src/cli/modes/interactive.js", () => ({
  startInteractiveMode: (...args: unknown[]) => startInteractiveModeMock(...args),
}));

import commandNotFound from "../../src/cli/hooks/command-not-found.js";

function fakeContext() {
  return {
    config: {},
    debug: () => {},
    error: () => {},
    exit: () => {},
    log: () => {},
    warn: () => {},
  } as unknown as import("@oclif/core").Hook.Context;
}

beforeEach(() => {
  startInteractiveModeMock.mockReset();
});

describe("command_not_found hook — the -i/--interactive fix", () => {
  it("starts interactive mode for '-i'", async () => {
    await commandNotFound.call(fakeContext(), { id: "-i" } as any);
    expect(startInteractiveModeMock).toHaveBeenCalledTimes(1);
  });

  it("starts interactive mode for '--interactive'", async () => {
    await commandNotFound.call(fakeContext(), { id: "--interactive" } as any);
    expect(startInteractiveModeMock).toHaveBeenCalledTimes(1);
  });

  it("starts interactive mode for an empty id", async () => {
    await commandNotFound.call(fakeContext(), { id: "" } as any);
    expect(startInteractiveModeMock).toHaveBeenCalledTimes(1);
  });

  it("starts interactive mode for an undefined id", async () => {
    await commandNotFound.call(fakeContext(), { id: undefined } as any);
    expect(startInteractiveModeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves without throwing for the interactive-mode cases", async () => {
    await expect(commandNotFound.call(fakeContext(), { id: "-i" } as any)).resolves.toBeUndefined();
  });
});

describe("command_not_found hook — genuine typos must still error (not be swallowed)", () => {
  it("throws for a misspelled command instead of silently launching interactive mode", async () => {
    await expect(commandNotFound.call(fakeContext(), { id: "rnu" } as any)).rejects.toThrow(
      /command rnu not found/,
    );
    expect(startInteractiveModeMock).not.toHaveBeenCalled();
  });

  it("throws for a real but different flag-like unmatched id", async () => {
    await expect(commandNotFound.call(fakeContext(), { id: "--verbose" } as any)).rejects.toThrow();
    expect(startInteractiveModeMock).not.toHaveBeenCalled();
  });

  it("includes the offending id in the thrown error message", async () => {
    await expect(commandNotFound.call(fakeContext(), { id: "totally-bogus" } as any)).rejects.toThrow(
      "command totally-bogus not found",
    );
  });
});
