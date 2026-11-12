import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
 *
 * Precedence: explicit options, environment variables, then
 * `~/.loopsteward/config.json` (or `LOOPSTEWARD_CONFIG`). The package ships
 * no default endpoint or model.
 */
export function resolveLlmConfig(overrides: LlmConfigOverrides = {}): LlmConfig {
  const file = readConfigFile();
  const baseUrl = pick(
    overrides.baseUrl,
    process.env.LOOPSTEWARD_BASE_URL,
    process.env.MAGPIE_BASE_URL,
    file.baseUrl,
  );
  const model = pick(
    overrides.model,
    process.env.LOOPSTEWARD_MODEL,
    process.env.MAGPIE_MODEL,
    file.model,
  );
  const apiKey = pick(
    overrides.apiKey,
    process.env.LOOPSTEWARD_API_KEY,
    process.env.MAGPIE_API_KEY,
    file.apiKey,
  );
  return {
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}

function pick(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function readConfigFile(): Partial<LlmConfig> {
  const configPath = process.env.LOOPSTEWARD_CONFIG?.trim()
    || path.join(os.homedir(), '.loopsteward', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
    };
  } catch {
    return {};
  }
}
