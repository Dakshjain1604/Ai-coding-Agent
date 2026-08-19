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
 * OpenAI's tiers have one runtime wrinkle: if no OPENAI_API_KEY is set but
 * an NVIDIA one is, fall back to an NVIDIA-hosted open model instead.
 * Computed fresh per call (not cached at module load) since env vars can
 * be set after the process starts (e.g. by a config command).
 *
 * Model choices confirmed live against NVIDIA's real API (integrate.api.
 * nvidia.com) with this codebase's real 20-tool schema set — all four
 * return correct, well-formed native tool_calls:
 *  - "meta/llama-3.1-8b-instruct": fastest (~0.5s) — used for speed/simple.
 *  - "z-ai/glm-5.2": fast (~3.5s) — used for the default/code tier
 *    (matches OpenAIProvider.ts's own NVIDIA default, kept in sync).
 *  - "meta/llama-3.1-70b-instruct": slower (~8s) but larger — used for
 *    quality/complex/reasoning.
 * "meta/llama-3.3-70b-instruct" and "openai/gpt-oss-120b" (both real,
 * listed model IDs) were also tried and confirmed to hang indefinitely
 * (100s+, no response) — NOT used here despite existing in the catalog.
 * NVIDIA's catalog rotates — every model here returns a real, near-term
 * `deprecation` response header (e.g. confirmed live: glm-5.2 carries
 * "deprecation: 2026-08-25...") — treat this as illustrative, not
 * permanent, same caveat as OpenRouter's model lists.
 */
/**
 * Exported so ModelRouter.isPaidProvider() can use the exact same
 * detection this file and OpenAIProvider.ts's own constructor already
 * use — see isPaidProvider()'s comment for why this matters: without it,
 * a real, confirmed-live-working, genuinely FREE NVIDIA fallback gets
 * silently blocked by the app's own `fallbackToPaid: false` safety
 * default (config.ts), because it shares the "openai" ProviderType with
 * real, actually-paid OpenAI usage and the router can't otherwise tell
 * them apart.
 */
export function useNvidiaFallback(): boolean {
  return (
    !process.env.OPENAI_API_KEY &&
    (Boolean(process.env.NVIDIA_API_KEY) || Boolean(process.env.NVAPI_KEY))
  );
}

function openaiDefaultTier(): CategoryModelMap {
  if (useNvidiaFallback()) {
    return {
      simple: "z-ai/glm-5.2",
      code: "z-ai/glm-5.2",
      complex: "z-ai/glm-5.2",
      reasoning: "z-ai/glm-5.2",
      embedding: "z-ai/glm-5.2", // embed() throws for NVIDIA regardless — see OpenAIProvider.ts
    };
  }
  return {
    simple: "gpt-4o-mini",
    code: "gpt-4o",
    complex: "o1-preview",
    reasoning: "o1-preview",
    embedding: "text-embedding-3-small",
  };
}

function openaiQualityTier(): CategoryModelMap {
  if (useNvidiaFallback()) {
    return {
      simple: "meta/llama-3.1-70b-instruct",
      code: "meta/llama-3.1-70b-instruct",
      complex: "meta/llama-3.1-70b-instruct",
      reasoning: "meta/llama-3.1-70b-instruct",
      embedding: "meta/llama-3.1-70b-instruct",
    };
  }
  return {
    simple: "gpt-4o",
    code: "o1-preview",
    complex: "o1-preview",
    reasoning: "o1-preview",
    embedding: "text-embedding-3-large",
  };
}

function openaiSpeedTier(): CategoryModelMap {
  if (useNvidiaFallback()) {
    return {
      simple: "meta/llama-3.1-8b-instruct",
      code: "meta/llama-3.1-8b-instruct",
      complex: "meta/llama-3.1-8b-instruct",
      reasoning: "meta/llama-3.1-8b-instruct",
      embedding: "meta/llama-3.1-8b-instruct",
    };
  }
  return {
    simple: "gpt-4o-mini",
    code: "gpt-4o-mini",
    complex: "gpt-4o",
    reasoning: "gpt-4o",
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
    quality: openaiQualityTier,
    speed: openaiSpeedTier,
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
  // "default"/"speed" tiers fixed to models confirmed live, right now,
  // against OpenRouter's real API to (a) actually exist — the previous
  // IDs here ("stepfun/step-3.5-flash:free", "google/gemma-2-9b-it:free",
  // "google/gemma-2-9b-8192-it") all 404/don't exist in OpenRouter's
  // current catalog — and (b) successfully return native tool_calls
  // against this codebase's real tool schemas. Keep in sync with
  // OpenRouterProvider.OPENROUTER_FREE_TOOL_MODELS, the source of truth.
  // "quality" tier's chat models are left as-is (a paid tier, unreachable
  // without real OpenRouter credit, out of scope for the free-tier
  // verification this fix is based on) — only its embedding field, using
  // the same broken ID pattern, is fixed for consistency; note OpenRouter's
  // own embed() always throws regardless (see OpenRouterProvider.ts), so
  // no embedding field here is actually reachable at runtime today.
  //
  // "default" tier's chat models were "openai/gpt-oss-20b:free" until this
  // fix — confirmed live, across 6+ separate real SWE-bench task runs
  // spanning two different tasks, that this specific free model reliably
  // returns a completely empty completion (no text, no tool calls) on
  // real tool-heavy conversations, every single time real traffic landed
  // on it, eventually exhausting the bounded blank-response retry budget
  // and failing the task outright. "google/gemma-4-31b-it:free" (already
  // used for the "quality" tier) was reached in the SAME real runs — via
  // OpenRouter's own server-side `models` fallback list on an unrelated
  // trigger (a payload-too-large error) — and produced real, valid content
  // every time. Until nvidia/nemotron-nano-9b-v2:free gets similar live
  // verification (it has never actually been exercised by real traffic in
  // any of these runs), gemma is the only free chat model on this list
  // with an actual track record, so both tiers now point to it.
  openrouter: {
    default: {
      simple: "google/gemma-4-31b-it:free",
      code: "google/gemma-4-31b-it:free",
      complex: "google/gemma-4-31b-it:free",
      reasoning: "google/gemma-4-31b-it:free",
      embedding: "openai/gpt-oss-20b:free",
    },
    // The previous "quality" tier here ("meta-llama/llama-3.1-70b-
    // instruct") is a real model but a PAID one — unreachable on a
    // free-tier-only key (confirmed live: the identical mistake with
    // "stepfun/step-3.5-flash" earlier returned 402 "Insufficient
    // credits"). Requesting it on a free key would just force
    // attemptDynamicFallback() to burn an extra retry cycle discovering
    // that, every single time a reasoning/complex task tried to use it.
    // "google/gemma-4-31b-it:free" is the largest of the three confirmed-
    // live-working free models (OPENROUTER_FREE_TOOL_MODELS in
    // OpenRouterProvider.ts) — a real, if modest, step up from the -20b
    // default that's actually reachable on this project's free-tier setup.
    quality: {
      simple: "google/gemma-4-31b-it:free",
      code: "google/gemma-4-31b-it:free",
      complex: "google/gemma-4-31b-it:free",
      reasoning: "google/gemma-4-31b-it:free",
      embedding: "openai/gpt-oss-20b:free",
    },
    speed: {
      simple: "nvidia/nemotron-nano-9b-v2:free",
      code: "nvidia/nemotron-nano-9b-v2:free",
      complex: "nvidia/nemotron-nano-9b-v2:free",
      reasoning: "nvidia/nemotron-nano-9b-v2:free",
      embedding: "nvidia/nemotron-nano-9b-v2:free",
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
