/**
 * Tool Registry - Central registry for agent tools
 * Provides a unified interface for tool registration, discovery, and execution
 */

import { getLogger } from "../../utils/logger.js";
import type { AgentTool } from "../agents/BaseAgent.js";
import type { ToolResult } from "../../utils/types.js";
import { TOOL_SETS } from "../agents/tool-sets.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
  /**
   * Required by JSON Schema for `type: "array"` (and enforced strictly by
   * some function-calling backends — confirmed live via OpenRouter routed
   * to Google AI Studio: "GenerateContentRequest.tools[...].parameters.
   * properties[x].items: missing field" — a real 400 on every tool with an
   * array param and no `items`). Groq/OpenAI's validators are laxer and
   * silently accepted the same schema, which is exactly why this went
   * unnoticed until a stricter backend was tested against.
   */
  items?: { type: "string" | "number" | "boolean" | "object" };
}

/**
 * Tool Registry
 * Manages tool registration and execution
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private logger = getLogger();

  /**
   * Register a tool
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(
        `Tool "${tool.name}" is already registered, overwriting`,
      );
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered tool: ${tool.name}`);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Get a tool by name
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Execute a tool
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Tool not found: ${name}`,
      };
    }

    // Validate parameters
    const validation = this.validateParameters(tool, params);
    if (!validation.valid) {
      return {
        success: false,
        output: `Invalid parameters: ${validation.errors.join(", ")}`,
      };
    }

    // Apply defaults
    const paramsWithDefaults = this.applyDefaults(tool, params);

    try {
      this.logger.debug(`Executing tool: ${name}`);
      const result = await tool.handler(paramsWithDefaults);
      this.logger.debug(
        `Tool ${name} completed: ${result.success ? "success" : "failed"}`,
      );
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`Tool ${name} failed: ${errorMessage}`);
      return {
        success: false,
        output: errorMessage,
        metadata: { error },
      };
    }
  }

  /**
   * Convert to AgentTool format
   */
  toAgentTool(name: string): AgentTool | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;

    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (params: Record<string, unknown>) => {
        const result = await this.execute(tool.name, params);
        if (!result.success) {
          throw new Error(result.output || `Tool ${tool.name} failed execution.`);
        }
        return result;
      },
    };
  }

  /**
   * Get tools for a specific agent type
   */
  getToolsForAgent(agentType: string): ToolDefinition[] {
    const allowedTools =
      TOOL_SETS[agentType as keyof typeof TOOL_SETS] ??
      TOOL_SETS.code;
    return this.getAll().filter((tool) => allowedTools.includes(tool.name));
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private validateParameters(
    tool: ToolDefinition,
    params: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [name, param] of Object.entries(tool.parameters)) {
      if (param.required && !(name in params)) {
        errors.push(`Missing required parameter: ${name}`);
      }

      if (name in params && params[name] !== undefined) {
        const value = params[name];
        const typeMatch = this.checkType(value, param.type);

        if (!typeMatch) {
          errors.push(`Parameter ${name} must be of type ${param.type}`);
        }

        if (param.enum && !param.enum.includes(String(value))) {
          errors.push(
            `Parameter ${name} must be one of: ${param.enum.join(", ")}`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private checkType(value: unknown, type: string): boolean {
    switch (type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && !isNaN(value as number);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return (
          typeof value === "object" && value !== null && !Array.isArray(value)
        );
      case "array":
        return Array.isArray(value);
      default:
        return true;
    }
  }

  private applyDefaults(
    tool: ToolDefinition,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...params };

    for (const [name, param] of Object.entries(tool.parameters)) {
      if (param.default !== undefined && !(name in params)) {
        result[name] = param.default;
      }
    }

    return result;
  }
}

// Singleton instance
let toolRegistryInstance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!toolRegistryInstance) {
    toolRegistryInstance = new ToolRegistry();
  }
  return toolRegistryInstance;
}

export function resetToolRegistry(): void {
  toolRegistryInstance = null;
}
