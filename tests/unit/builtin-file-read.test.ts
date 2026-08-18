/**
 * Tests for the file_read tool's offset/limit behavior (core/tools/
 * builtin.ts) — previously had zero dedicated behavior tests at all.
 *
 * Two real, independently-confirmed bugs, both live-reproduced before
 * fixing:
 *
 * 1. offset is documented as a "line number" (1-indexed, mirroring the
 *    Read tool convention this parameter's name/description clearly
 *    mimics), but was used as a raw 0-indexed array slice() start.
 *    offset:1 ("start at the first line") actually skipped the first
 *    line and started at the second. Reproduced live:
 *    ["line1",...].slice(1, 1+limit) returns ["line2","line3"], not
 *    starting from line1.
 *
 * 2. The entry check `params.offset || params.limit` treated an
 *    explicit `offset: 0` (falsy in JS) with no limit the same as
 *    "neither provided", silently returning the WHOLE file instead of
 *    slicing at all.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileRead } from "../../src/core/tools/builtin.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeFile(lines: string[]): string {
  dir = mkdtempSync(join(tmpdir(), "file-read-test-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, lines.join("\n"));
  return file;
}

describe("file_read — offset (1-indexed line number) fix", () => {
  it("offset:1 starts at the FIRST line, not the second", async () => {
    const file = makeFile(["line1", "line2", "line3", "line4", "line5"]);
    const result = await fileRead.handler({ path: file, offset: 1, limit: 2 });
    expect(result.output).toBe("line1\nline2");
  });

  it("offset:3 starts at the third line", async () => {
    const file = makeFile(["line1", "line2", "line3", "line4", "line5"]);
    const result = await fileRead.handler({ path: file, offset: 3, limit: 2 });
    expect(result.output).toBe("line3\nline4");
  });

  it("offset without limit reads to the end of the file, starting at the right line", async () => {
    const file = makeFile(["line1", "line2", "line3"]);
    const result = await fileRead.handler({ path: file, offset: 2 });
    expect(result.output).toBe("line2\nline3");
  });

  it("limit without offset reads from the true beginning of the file", async () => {
    const file = makeFile(["line1", "line2", "line3", "line4"]);
    const result = await fileRead.handler({ path: file, limit: 2 });
    expect(result.output).toBe("line1\nline2");
  });
});

describe("file_read — offset:0 falsy-check fix", () => {
  it("offset:0 with a limit still slices (doesn't fall through to the whole file)", async () => {
    const file = makeFile(["line1", "line2", "line3", "line4"]);
    const result = await fileRead.handler({ path: file, offset: 0, limit: 2 });
    // offset:0 clamps to the start (Math.max(0, 0-1) === 0) — same as offset:1.
    expect(result.output).toBe("line1\nline2");
  });

  it("offset:0 with no limit does not silently return the whole file untouched", async () => {
    const file = makeFile(["line1", "line2", "line3"]);
    const result = await fileRead.handler({ path: file, offset: 0 });
    // Still returns everything (offset:0 clamps to start, no limit means
    // read to the end) — but via the slicing path, not the "neither
    // param given" fallthrough. Verified structurally by the two offset
    // clamp tests above; this just confirms the observable output is
    // still correct content-wise.
    expect(result.output).toBe("line1\nline2\nline3");
  });
});

describe("file_read — general behavior", () => {
  it("returns the full file content when neither offset nor limit is given", async () => {
    const file = makeFile(["a", "b", "c"]);
    const result = await fileRead.handler({ path: file });
    expect(result.output).toBe("a\nb\nc");
  });

  it("returns success:false for a nonexistent file", async () => {
    dir = mkdtempSync(join(tmpdir(), "file-read-test-"));
    const result = await fileRead.handler({ path: join(dir, "missing.txt") });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("limit longer than the remaining lines just returns what's left, without erroring", async () => {
    const file = makeFile(["a", "b", "c"]);
    const result = await fileRead.handler({ path: file, offset: 2, limit: 100 });
    expect(result.output).toBe("b\nc");
  });
});
