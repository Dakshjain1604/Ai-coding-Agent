import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getToolRegistry } from "../../src/core/tools/ToolRegistry.js";
import {
  ensureBuiltinToolsRegistered,
  workspaceVerify,
} from "../../src/core/tools/builtin.js";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";
import { TOOL_SETS } from "../../src/core/agents/tool-sets.js";
import { getPermissionSystem } from "../../src/utils/permission-system.js";
import { createGitTools } from "../../src/core/tools/git-operations.js";

describe("ToolRegistry & Built-in Tools", () => {
  it("should register built-in tools and retrieve agent tool definition", () => {
    ensureBuiltinToolsRegistered();
    const registry = getToolRegistry();
    expect(registry.has("file_read")).toBe(true);
    expect(registry.has("file_write")).toBe(true);
    expect(registry.has("workspace_verify")).toBe(true);
  });

  it("should convert ToolDefinition to AgentTool schema", () => {
    const registry = getToolRegistry();
    const agentTool = registry.toAgentTool("file_read");
    expect(agentTool).toBeDefined();
    expect(agentTool?.name).toBe("file_read");
    expect(agentTool?.parameters.path.type).toBe("string");
  });

  // Regression test for the Wiring Audit's fix #5: code-search tools were
  // fully implemented but never registered, never in any mode's tool set,
  // and had no permission rule (which would deny them outright even if
  // registered). All three had to be fixed for this to actually work.
  it("registers code-search tools, includes them in code/debug/review tool sets, and permits them", async () => {
    const registry = getToolRegistry();
    for (const name of ["search_content", "grep", "find_usages", "directory_create"]) {
      expect(registry.has(name)).toBe(true);
    }

    expect(TOOL_SETS.code).toContain("search_content");
    expect(TOOL_SETS.debug).toContain("find_usages");
    expect(TOOL_SETS.review).toContain("analyze_imports");

    // count_lines was fully implemented, registered, and tested, but
    // appeared in NO mode's TOOL_SETS entry at all — since TOOL_SETS is
    // a strict whitelist (UniversalAgent.ts/ToolRegistry.ts both use it
    // that way), it was permanently unreachable by every agent mode.
    expect(registry.has("count_lines")).toBe(true);
    expect(TOOL_SETS.review).toContain("count_lines");

    const check = getPermissionSystem().checkPermission("search_content", {});
    expect(check.allowed).toBe(true);

    // End-to-end: actually run search_content through executeTool (which
    // includes the hook + permission pipeline) against this repo, looking
    // for a symbol that's guaranteed to exist.
    const agent = new UniversalAgent("code");
    const result = (await (agent as unknown as {
      executeTool: (
        name: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }).executeTool("search_content", {
      directory: "src/core/agents",
      pattern: "UniversalAgent",
      filePattern: "*.ts",
    })) as { success: boolean; output: string };

    expect(result.success).toBe(true);
    expect(result.output).toContain("UniversalAgent");
  });
});

// Regression coverage for architecture-optimal.md Phase 2 item C5: no lint
// step existed anywhere in the tool layer before this — workspace_verify
// only ever ran tsc + tests.
describe("workspace_verify risk-aware lint step (C5)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeTempProject(lintScript: string): string {
    const d = mkdtempSync(join(tmpdir(), "workspace-verify-test-"));
    writeFileSync(
      join(d, "package.json"),
      JSON.stringify({ name: "tmp", scripts: { lint: lintScript } }),
    );
    return d;
  }

  it("runs lint and reports failure when risk is high and lint fails", async () => {
    dir = makeTempProject("exit 1");

    const result = (await workspaceVerify.handler({
      cwd: dir,
      runTests: false,
      risk: "high",
    })) as { success: boolean; metadata: { lint: string } };

    expect(result.metadata.lint).toBe("FAILED");
    expect(result.success).toBe(false);
  });

  it("skips lint when risk is low, even with a failing lint script", async () => {
    dir = makeTempProject("exit 1");

    const result = (await workspaceVerify.handler({
      cwd: dir,
      runTests: false,
      risk: "low",
    })) as { success: boolean; metadata: { lint: string } };

    expect(result.metadata.lint).toBe("SKIPPED");
  });

  it("skips lint entirely when the target project has no lint script", async () => {
    dir = mkdtempSync(join(tmpdir(), "workspace-verify-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp" }));

    const result = (await workspaceVerify.handler({
      cwd: dir,
      runTests: false,
      risk: "high",
    })) as { success: boolean; metadata: { lint: string } };

    expect(result.metadata.lint).toBe("SKIPPED");
  });
});

// Regression coverage for the git-tools-hardening phase: git_branch/
// git_checkout/git_reset/git_remote/git_push/git_pull (git-operations.ts)
// were fully implemented but createGitTools() had zero call sites
// anywhere — the agent had no way to create/switch branches, push, pull,
// or reset at all. Also verifies the file-write-tool dedup discipline
// from the prior phase wasn't quietly reintroduced for git tools: exactly
// one implementation per tool name should ever reach the registry.
describe("Newly wired git tools (git_branch/checkout/reset/remote/push/pull)", () => {
  it("registers all six in the real tool registry", () => {
    ensureBuiltinToolsRegistered();
    const registry = getToolRegistry();
    for (const name of [
      "git_branch",
      "git_checkout",
      "git_reset",
      "git_remote",
      "git_push",
      "git_pull",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("grants all six to code mode's tool set", () => {
    for (const name of [
      "git_branch",
      "git_checkout",
      "git_reset",
      "git_remote",
      "git_push",
      "git_pull",
    ]) {
      expect(TOOL_SETS.code).toContain(name);
    }
  });

  it("grants only the non-destructive pair (git_branch/git_checkout) to debug mode", () => {
    expect(TOOL_SETS.debug).toContain("git_branch");
    expect(TOOL_SETS.debug).toContain("git_checkout");
    for (const name of ["git_reset", "git_remote", "git_push", "git_pull"]) {
      expect(TOOL_SETS.debug).not.toContain(name);
    }
  });

  it("withholds all six from the read-only review and plan modes", () => {
    for (const mode of ["review", "plan"] as const) {
      for (const name of [
        "git_branch",
        "git_checkout",
        "git_reset",
        "git_remote",
        "git_push",
        "git_pull",
      ]) {
        expect(TOOL_SETS[mode]).not.toContain(name);
      }
    }
  });

  it("converts each to a valid AgentTool schema", () => {
    const registry = getToolRegistry();
    for (const name of ["git_branch", "git_checkout", "git_reset", "git_remote", "git_push", "git_pull"]) {
      const agentTool = registry.toAgentTool(name);
      expect(agentTool).toBeDefined();
      expect(agentTool?.name).toBe(name);
    }
  });

  it("registers exactly one implementation per overlapping git tool name (no reintroduced duplication)", () => {
    // git_status/git_diff/git_log/git_add/git_commit exist in BOTH
    // builtin.ts (individually registered) and used to also exist in
    // git-operations.ts before that duplication was removed. Guard
    // against it silently coming back: git-operations.ts's createGitTools()
    // must not define any of the five overlapping names.
    const overlapping = ["git_status", "git_diff", "git_log", "git_add", "git_commit"];
    const gitOpsNames = createGitTools().map((t) => t.name);
    for (const name of overlapping) {
      expect(gitOpsNames).not.toContain(name);
    }
  });
});
