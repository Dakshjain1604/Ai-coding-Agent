/**
 * Provider Registry - a typed capability map replacing the three
 * near-identical per-provider switch tables that used to live inline in
 * ModelRouter (getDefaultModelForCategory / getBetterModel / getFasterModel).
 *
 * This is deliberately NOT a plugin/DI framework (see the Field Guide's
 * verdict on deepseek-harness's Cordis system as overkill for this
 * project's scale) — it's a lookup table. Extend it here as new providers
 * or models are added; do not add more per-provider `if` branches to
 * ModelRouter itself.
 */

import type { ProviderType } from "../utils/types.js";

export type TaskCategory =
  | "simple"
  | "code"
  | "complex"
  | "reasoning"
  | "embedding";

/** default = cheapest reasonable choice, quality = best available, speed = fastest available. */
export type ModelTier = "default" | "quality" | "speed";

export type CategoryModelMap = Record<TaskCategory, string>;

/**
 * OpenAI's default tier has one runtime wrinkle: if no OPENAI_API_KEY is
 * set but an NVIDIA one is, fall back to an NVIDIA-hosted open model
 * instead. Computed fresh per call (not cached at module load) since env
 * vars can be set after the process starts (e.g. by a config command).
 */
function openaiDefaultTier(): CategoryModelMap {
  const useNvidiaFallback =
    !process.env.OPENAI_API_KEY &&
    (Boolean(process.env.NVIDIA_API_KEY) || Boolean(process.env.NVAPI_KEY));
  const nvidiaModel = "meta/llama-3.1-8b-instruct";

  return {
    simple: useNvidiaFallback ? nvidiaModel : "gpt-4o-mini",
    code: useNvidiaFallback ? nvidiaModel : "gpt-4o",
    complex: useNvidiaFallback ? nvidiaModel : "o1-preview",
    reasoning: useNvidiaFallback ? nvidiaModel : "o1-preview",
    embedding: "text-embedding-3-small",
  };
}

type TierValue = CategoryModelMap | (() => CategoryModelMap);
type ProviderModelMap = Record<ProviderType, Record<ModelTier, TierValue>>;

const LOCAL_ALL_TIERS: CategoryModelMap = {
  simple: "qwen2.5-coder:latest",
  code: "qwen2.5-coder:latest",
  complex: "qwen2.5-coder:latest",
  reasoning: "qwen2.5-coder:latest",
  embedding: "nomic-embed-text",
};

const MODEL_MAP: ProviderModelMap = {
  local: {
    default: LOCAL_ALL_TIERS,
    quality: LOCAL_ALL_TIERS,
    speed: LOCAL_ALL_TIERS,
  },
  ollama: {
    default: LOCAL_ALL_TIERS,
    quality: LOCAL_ALL_TIERS,
    speed: LOCAL_ALL_TIERS,
  },
  claude: {
    default: {
      simple: "claude-haiku-4-5-20251001",
      code: "claude-sonnet-4-6",
      complex: "claude-opus-4-6",
      reasoning: "claude-opus-4-6",
      embedding: "claude-haiku-4-5-20251001", // Claude has no embeddings API
    },
    quality: {
      simple: "claude-sonnet-4-6",
      code: "claude-opus-4-6",
      complex: "claude-opus-4-6",
      reasoning: "claude-opus-4-6",
      embedding: "claude-haiku-4-5-20251001",
    },
    speed: {
      simple: "claude-haiku-4-5-20251001",
      code: "claude-haiku-4-5-20251001",
      complex: "claude-sonnet-4-6",
      reasoning: "claude-sonnet-4-6",
      embedding: "claude-haiku-4-5-20251001",
    },
  },
  openai: {
    default: openaiDefaultTier,
    quality: {
      simple: "gpt-4o",
      code: "o1-preview",
      complex: "o1-preview",
      reasoning: "o1-preview",
      embedding: "text-embedding-3-large",
    },
    speed: {
      simple: "gpt-4o-mini",
      code: "gpt-4o-mini",
      complex: "gpt-4o",
      reasoning: "gpt-4o",
      embedding: "text-embedding-3-small",
    },
  },
  gemini: {
    default: {
      simple: "gemini-2.0-flash",
      code: "gemini-2.0-flash",
      complex: "gemini-2.0-pro",
      reasoning: "gemini-2.0-pro",
      embedding: "text-embedding-004",
    },
    quality: {
      simple: "gemini-2.0-pro",
      code: "gemini-2.0-pro",
      complex: "gemini-2.0-pro",
      reasoning: "gemini-2.0-pro",
      embedding: "text-embedding-004",
    },
    speed: {
      simple: "gemini-2.0-flash",
      code: "gemini-2.0-flash",
      complex: "gemini-2.0-flash",
      reasoning: "gemini-2.0-flash",
      embedding: "text-embedding-004",
    },
  },
  groq: {
    // Groq's free tier caps at 8000 TPM per request on gpt-oss-120b — a
    // single call with a full tool-schema system prompt (~9k tokens) blows
    // that limit outright. gpt-oss-20b has enough free-tier headroom to
    // carry the same prompt, so it's the safe default; 120b is opt-in via
    // the "quality" tier for anyone on a paid Groq plan.
    default: {
      simple: "openai/gpt-oss-20b",
      code: "openai/gpt-oss-20b",
      complex: "openai/gpt-oss-20b",
      reasoning: "openai/gpt-oss-20b",
      embedding: "text-embedding-3-small",
    },
    quality: {
      simple: "openai/gpt-oss-120b",
      code: "openai/gpt-oss-120b",
      complex: "openai/gpt-oss-120b",
      reasoning: "openai/gpt-oss-120b",
      embedding: "text-embedding-3-small",
    },
    speed: {
      simple: "openai/gpt-oss-20b",
      code: "openai/gpt-oss-20b",
      complex: "openai/gpt-oss-120b",
      reasoning: "openai/gpt-oss-20b",
      embedding: "text-embedding-3-small",
    },
  },
  openrouter: {
    default: {
      simple: "stepfun/step-3.5-flash:free",
      code: "stepfun/step-3.5-flash:free",
      complex: "stepfun/step-3.5-flash:free",
      reasoning: "stepfun/step-3.5-flash:free",
      embedding: "google/gemma-2-9b-it:free",
    },
    quality: {
      simple: "meta-llama/llama-3.1-70b-instruct",
      code: "meta-llama/llama-3.1-70b-instruct",
      complex: "meta-llama/llama-3.1-70b-instruct",
      reasoning: "meta-llama/llama-3.1-70b-instruct",
      embedding: "google/gemma-2-9b-8192-it",
    },
    speed: {
      simple: "google/gemma-2-9b-8192-it",
      code: "google/gemma-2-9b-8192-it",
      complex: "meta-llama/llama-3.1-8b-instruct",
      reasoning: "google/gemma-2-9b-8192-it",
      embedding: "google/gemma-2-9b-8192-it",
    },
  },
  huggingface: {
    default: {
      simple: "meta-llama/Llama-3.2-1B-Instruct",
      code: "meta-llama/Llama-3.2-3B-Instruct",
      complex: "Qwen/Qwen2.5-7B-Instruct",
      reasoning: "Qwen/Qwen2.5-7B-Instruct",
      embedding: "BAAI/bge-small-en-v1.5",
    },
    quality: {
      simple: "Qwen/Qwen2.5-Coder-3B-Instruct",
      code: "Qwen/Qwen2.5-7B-Instruct",
      complex: "Qwen/Qwen2.5-7B-Instruct",
      reasoning: "Qwen/Qwen2.5-7B-Instruct",
      embedding: "BAAI/bge-small-en-v1.5",
    },
    speed: {
      simple: "meta-llama/Llama-3.2-1B-Instruct",
      code: "meta-llama/Llama-3.2-1B-Instruct",
      complex: "Qwen/Qwen2.5-Coder-3B-Instruct",
      reasoning: "meta-llama/Llama-3.2-1B-Instruct",
      embedding: "BAAI/bge-small-en-v1.5",
    },
  },
  "ollama-cloud": {
    default: {
      simple: "llama3.2",
      code: "llama3.2",
      complex: "llama3.1",
      reasoning: "llama3.1",
      embedding: "nomic-embed-text",
    },
    quality: {
      simple: "llama3.2",
      code: "llama3.2",
      complex: "llama3.1",
      reasoning: "llama3.1",
      embedding: "nomic-embed-text",
    },
    speed: {
      simple: "llama3.2",
      code: "llama3.2",
      complex: "llama3.2",
      reasoning: "llama3.2",
      embedding: "nomic-embed-text",
    },
  },
};

/**
 * Resolves the model for a (provider, tier, category) triple. Falls back to
 * `local`'s default tier if the provider isn't in the map at all (should
 * only happen for a genuinely unknown ProviderType).
 */
export function getModelFor(
  providerType: ProviderType,
  tier: ModelTier,
  taskCategory: TaskCategory,
): string {
  const providerEntry = MODEL_MAP[providerType] ?? MODEL_MAP.local;
  const tierValue = providerEntry[tier] ?? providerEntry.default;
  const categoryMap =
    typeof tierValue === "function" ? tierValue() : tierValue;
  return categoryMap[taskCategory];
}
