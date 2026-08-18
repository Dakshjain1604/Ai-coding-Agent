/**
 * Tests for BaseAgent.getToolSchemas() — previously had zero coverage at
 * all, despite being what builds the tool schema sent to every LLM
 * provider's native function-calling API on every single call.
 *
 * Centerpiece regression: AgentTool.parameters is a FLAT map (e.g.
 * {path: {type, required}, content: {type, required}}), not a
 * JSON-Schema-style {properties, required} object. getToolSchemas() used
 * to read `tool.parameters.required` directly — a field that never
 * exists on the flat map — so `required` was `[]` for every tool,
 * always, regardless of which individual parameters actually had
 * `required: true`. Since every provider (OpenAIProvider confirmed by
 * reading its request-building code, and by the same pattern Claude/
 * Gemini/Groq/OpenRouter, all fixed to forward native tool schemas
 * earlier this session) forwards ToolSchema.parameters verbatim into its
 * request, this meant every tool schema sent to every LLM provider told
 * the model that NOTHING was ever required, for every tool, for as long
 * as this bug existed.
 */
import { describe, it, expect } from "vitest";
import { UniversalAgent } from "../../src/core/agents/UniversalAgent.js";

describe("BaseAgent.getToolSchemas() — the always-empty-required fix", () => {
  it("marks file_write's genuinely required params (path, content) as required, and its optional param (mode) as not", () => {
    const agent = new UniversalAgent("code");
    const schemas = agent.getToolSchemas();
    const fileWrite = schemas.find((s) => s.name === "file_write");
    expect(fileWrite).toBeDefined();
    expect(fileWrite!.parameters.required).toContain("path");
    expect(fileWrite!.parameters.required).toContain("content");
    expect(fileWrite!.parameters.required).not.toContain("mode");
  });

  it("marks file_read's required param (path) as required, and its optional params (encoding/offset/limit) as not", () => {
    const agent = new UniversalAgent("code");
    const schemas = agent.getToolSchemas();
    const fileRead = schemas.find((s) => s.name === "file_read");
    expect(fileRead).toBeDefined();
    expect(fileRead!.parameters.required).toEqual(["path"]);
  });

  it("produces an empty required array for a tool where every parameter is optional", () => {
    const agent = new UniversalAgent("code");
    const schemas = agent.getToolSchemas();
    const gitStatus = schemas.find((s) => s.name === "git_status");
    expect(gitStatus).toBeDefined();
    expect(gitStatus!.parameters.required).toEqual([]);
  });

  it("still includes every parameter (required and optional) in properties, unaffected by the fix", () => {
    const agent = new UniversalAgent("code");
    const schemas = agent.getToolSchemas();
    const fileWrite = schemas.find((s) => s.name === "file_write");
    expect(Object.keys(fileWrite!.parameters.properties)).toEqual(
      expect.arrayContaining(["path", "content", "mode"]),
    );
  });

  it("sets parameters.type to 'object' for every schema", () => {
    const agent = new UniversalAgent("code");
    const schemas = agent.getToolSchemas();
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema.parameters.type).toBe("object");
    }
  });
});
