/**
 * Built-in Tools Module
 * Consolidated single source of truth forwarding to builtin.ts
 */

import { getToolRegistry } from "./ToolRegistry.js";
import { registerBuiltinTools } from "./builtin.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger();
let toolsRegistered = false;

export function registerBuiltInTools(): void {
  if (toolsRegistered) return;
  toolsRegistered = true;

  const registry = getToolRegistry();
  registerBuiltinTools(registry);
  logger.info("Built-in tools registered");
}

export * from "./builtin.js";
