/**
 * Tests for the post-tool-use and on-error built-in hooks
 * (hooks/built-in/post-tool-use.ts, hooks/built-in/on-error.ts).
 *
 * Both were previously pure no-op stubs: they destructured fields off
 * context.data (toolName, duration, success, result / error, taskId,
 * agentType) but never did anything with them, despite their own
 * docstrings explicitly promising "can log or process results" and "can
 * attempt recovery or log" — and despite being genuinely reachable on
 * every real tool call and every real error (BaseAgent.executeTool()
 * fires both unconditionally). Implemented the logging half of what
 * each hook's docstring already promises (not "recovery" — that's a
 * bigger, more speculative feature this pass intentionally left alone).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLogger } from "../../src/utils/logger.js";
import { postToolUseHook } from "../../src/hooks/built-in/post-tool-use.js";
import { onErrorHook } from "../../src/hooks/built-in/on-error.js";
import type { HookContext } from "../../src/hooks/types.js";

function makeContext(data: Record<string, unknown>): HookContext {
  return { event: "post-tool-use", timestamp: new Date(), data };
}

describe("postToolUseHook", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(getLogger(), "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it("logs a success-shaped message including the tool name and duration", async () => {
    const result = await postToolUseHook.handler(
      makeContext({ toolName: "file_read", duration: 42, success: true, result: "ok" }),
    );
    expect(result?.success).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("file_read"));
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("42ms"));
  });

  it("logs a failure-shaped message including the error when success is false", async () => {
    await postToolUseHook.handler(
      makeContext({ toolName: "shell_exec", duration: 10, success: false, error: "command not found" }),
    );
    const logged = debugSpy.mock.calls[0][0] as string;
    expect(logged).toContain("shell_exec");
    expect(logged).toContain("failed");
    expect(logged).toContain("command not found");
  });

  it("still returns success:true even when the tool call itself failed (hook succeeded at its own job: logging)", async () => {
    const result = await postToolUseHook.handler(
      makeContext({ toolName: "x", duration: 1, success: false, error: "boom" }),
    );
    expect(result?.success).toBe(true);
  });

  it("does not throw when optional fields are missing", async () => {
    await expect(postToolUseHook.handler(makeContext({}))).resolves.toEqual({ success: true });
  });

  it("has the name/event/priority the HookManager registration relies on", () => {
    expect(postToolUseHook.name).toBe("post-tool-use");
    expect(postToolUseHook.event).toBe("post-tool-use");
    expect(postToolUseHook.priority).toBe(50);
  });
});

describe("onErrorHook", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(getLogger(), "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs the agent type, task id, tool name, and error message", async () => {
    await onErrorHook.handler(
      makeContext({
        error: new Error("disk full"),
        toolName: "file_write",
        taskId: "t-123",
        agentType: "code",
      }),
    );
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).toContain("code");
    expect(logged).toContain("t-123");
    expect(logged).toContain("file_write");
    expect(logged).toContain("disk full");
  });

  it("still logs a usable message when taskId/agentType/toolName are absent", async () => {
    await onErrorHook.handler(makeContext({ error: new Error("network down") }));
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).toContain("network down");
    expect(logged).toContain("unknown");
  });

  it("handles a non-Error value in the error field without throwing", async () => {
    await expect(
      onErrorHook.handler(makeContext({ error: "just a string error" as unknown as Error })),
    ).resolves.toEqual({ success: true });
    expect(errorSpy.mock.calls[0][0]).toContain("just a string error");
  });

  it("always returns success:true (the hook's own job — logging — never fails the caller)", async () => {
    const result = await onErrorHook.handler(makeContext({ error: new Error("x") }));
    expect(result).toEqual({ success: true });
  });

  it("has the name/event/priority the HookManager registration relies on", () => {
    expect(onErrorHook.name).toBe("on-error");
    expect(onErrorHook.event).toBe("on-error");
    expect(onErrorHook.priority).toBe(100);
  });
});
