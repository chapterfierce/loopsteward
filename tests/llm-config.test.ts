import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLlmConfig } from '../src/loops/llm-config.js';

const KEYS = [
  'LOOPSTEWARD_BASE_URL',
  'LOOPSTEWARD_MODEL',
  'LOOPSTEWARD_API_KEY',
  'LOOPSTEWARD_CONFIG',
  'MAGPIE_BASE_URL',
  'MAGPIE_MODEL',
  'MAGPIE_API_KEY',
] as const;

const saved = new Map<string, string | undefined>();
const dirs: string[] = [];

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('resolveLlmConfig', () => {
  it('prefers the generic LoopSteward names', () => {
    setEnv({
      LOOPSTEWARD_BASE_URL: 'https://generic.example/v1',
      LOOPSTEWARD_MODEL: 'provider/generic',
      LOOPSTEWARD_API_KEY: 'generic-key',
      MAGPIE_BASE_URL: 'http://127.0.0.1:11434/v1',
      MAGPIE_MODEL: 'provider/magpie',
      MAGPIE_API_KEY: 'magpie-key',
    });

    expect(resolveLlmConfig()).toEqual({
      baseUrl: 'https://generic.example/v1',
      model: 'provider/generic',
      apiKey: 'generic-key',
    });
  });

  it('keeps the MAGPIE names as compatibility aliases', () => {
    setEnv({
      MAGPIE_BASE_URL: 'http://127.0.0.1:11434/v1',
      MAGPIE_MODEL: 'provider/magpie',
      MAGPIE_API_KEY: 'magpie-key',
    });

    expect(resolveLlmConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'provider/magpie',
      apiKey: 'magpie-key',
    });
  });

  it('lets explicit options override environment values', () => {
    setEnv({
      LOOPSTEWARD_BASE_URL: 'https://env.example/v1',
      LOOPSTEWARD_MODEL: 'provider/env',
    });

    expect(resolveLlmConfig({
      baseUrl: 'https://option.example/v1',
      model: 'provider/option',
    })).toMatchObject({
      baseUrl: 'https://option.example/v1',
      model: 'provider/option',
    });
  });

  it('returns empty strings when nothing is configured', () => {
    setEnv({});
    expect(resolveLlmConfig()).toEqual({ baseUrl: '', model: '' });
  });

  it('reads the local config file when no environment value is set', () => {
    const file = writeConfig({
      baseUrl: 'https://file.example/v1',
      model: 'provider/file',
      apiKey: 'file-key',
    });
    setEnv({ LOOPSTEWARD_CONFIG: file });

    expect(resolveLlmConfig()).toEqual({
      baseUrl: 'https://file.example/v1',
      model: 'provider/file',
      apiKey: 'file-key',
    });
  });

  it('lets environment values override the local config file', () => {
    const file = writeConfig({
      baseUrl: 'https://file.example/v1',
      model: 'provider/file',
    });
    setEnv({
      LOOPSTEWARD_CONFIG: file,
      LOOPSTEWARD_BASE_URL: 'https://env.example/v1',
      LOOPSTEWARD_MODEL: 'provider/env',
    });

    expect(resolveLlmConfig()).toMatchObject({
      baseUrl: 'https://env.example/v1',
      model: 'provider/env',
    });
  });

  it('ignores an unreadable or invalid config file', () => {
    const file = writeConfig('{ not json');
    setEnv({ LOOPSTEWARD_CONFIG: file });

    expect(resolveLlmConfig()).toEqual({ baseUrl: '', model: '' });
  });
});

function writeConfig(value: Record<string, string> | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-llm-config-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return file;
}
