export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmConfigOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/**
 * Resolve the OpenAI-compatible endpoint used for extraction.
 *
 * LoopSteward only needs `POST {baseUrl}/chat/completions`. Any
 * OpenAI-compatible gateway works, so the generic names win and the
 * historical MAGPIE_* names stay as aliases.
 */
export function resolveLlmConfig(overrides: LlmConfigOverrides = {}): LlmConfig {
  const baseUrl = (
    overrides.baseUrl
    ?? process.env.LOOPSTEWARD_BASE_URL
    ?? process.env.MAGPIE_BASE_URL
    ?? ''
  ).trim();
  const model = (
    overrides.model
    ?? process.env.LOOPSTEWARD_MODEL
    ?? process.env.MAGPIE_MODEL
    ?? ''
  ).trim();
  const apiKey = (
    overrides.apiKey
    ?? process.env.LOOPSTEWARD_API_KEY
    ?? process.env.MAGPIE_API_KEY
    ?? ''
  ).trim();
  return {
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}
