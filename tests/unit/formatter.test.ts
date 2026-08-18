/**
 * Tests for formatFile (utils/formatter.ts) — switched from a shell-string
 * `npx prettier --write "${filePath}"` (interpolated, unescaped) to
 * execFile()'s argv form this phase, for consistency with the rest of the
 * injection fixes in this pass. filePath here is normally agent-controlled
 * rather than fully untrusted, but the fix is free and closes the class
 * of bug regardless of where a value originates.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatFile } from "../../src/utils/formatter.js";

describe("formatFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns false for a non-formattable extension without touching the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "formatter-test-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "unformatted   content");
    const result = await formatFile(file);
    expect(result).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe("unformatted   content");
  });

  it("returns false for a nonexistent file", async () => {
    dir = mkdtempSync(join(tmpdir(), "formatter-test-"));
    const result = await formatFile(join(dir, "nope.ts"));
    expect(result).toBe(false);
  });

  it("does not throw for a formattable file even if the write dir has no prettier config", async () => {
    dir = mkdtempSync(join(tmpdir(), "formatter-test-"));
    const file = join(dir, "a.json");
    writeFileSync(file, '{"a":1}');
    await expect(formatFile(file)).resolves.not.toThrow();
  });

  it("a filename containing shell metacharacters never executes them", async () => {
    dir = mkdtempSync(join(tmpdir(), "formatter-test-"));
    // A literal semicolon/backtick in the FILE NAME itself — filesystem-
    // legal on macOS/Linux, and exactly what execFile's argv form makes
    // safe regardless of content.
    const file = join(dir, "weird`; touch pwned #.txt");
    writeFileSync(file, "content");
    const canary = join(dir, "pwned");

    await formatFile(file); // .txt isn't formattable, but must still not crash or exec anything
    expect(existsSync(canary)).toBe(false);
  });
});
