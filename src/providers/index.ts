/**
 * Providers module exports
 */

export { BaseProvider } from "./ProviderInterface.js";
export type {
  ChatMessage,
  ContentBlock,
  CompletionResult,
  UsageStats,
  ProviderCapabilities,
} from "./ProviderInterface.js";

export { ClaudeProvider } from "./ClaudeProvider.js";
export type { ClaudeConfig } from "./ClaudeProvider.js";

export { OpenAIProvider } from "./OpenAIProvider.js";
export type { OpenAIConfig } from "./OpenAIProvider.js";

export { GeminiProvider } from "./GeminiProvider.js";
export type { GeminiConfig } from "./GeminiProvider.js";

export { LocalProvider } from "./LocalProvider.js";
export type { LocalConfig } from "./LocalProvider.js";

export {
  ProviderFactory,
  getProviderFactory,
  createProvider,
} from "./ProviderFactory.js";
export type { ProviderOptions } from "./ProviderFactory.js";

export {
  ModelRouter,
  getModelRouter,
  resetModelRouter,
} from "./ModelRouter.js";
export type {
  TaskCategory,
  CostPreference,
  RoutingRule,
  RoutingResult,
  RoutingConfig,
} from "./ModelRouter.js";
