import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readMagpieMemory,
  readMagpieDistill,
  normalizeMemory,
  summarize,
  scanMagpie,
  MagpieSourceError,
} from '../src/magpie/magpie-source.js';

const memoryPath = fileURLToPath(new URL('./fixtures/magpie/memory.sample.json', import.meta.url));
const distillPath = fileURLToPath(new URL('./fixtures/magpie/distill.sample.json', import.meta.url));

describe('MagpieSource', () => {
  it('normalizes project scopes and deduplicates agents', () => {
    const file = readMagpieMemory(memoryPath);
    const signals = normalizeMemory(file);
    expect(signals).toHaveLength(3);
    expect(signals[0]).toMatchObject({
      id: 'm_alpha',
      kind: 'episode',
      projectName: 'alpha',
      agents: ['claude'],
    });
    expect(signals[0].projectDir).toContain('alpha');
    expect(signals[1]).toMatchObject({ id: 'm_global', projectKey: 'global', projectDir: null });
    expect(signals[2].projectName).toBe('beta');
  });

  it('summarizes by agent, project, kind, status and distill sessions', () => {
    const file = readMagpieMemory(memoryPath);
    const distill = readMagpieDistill(distillPath);
    const summary = summarize(normalizeMemory(file), distill);
    expect(summary.total).toBe(3);
    expect(summary.byAgent).toEqual({ claude: 2, codex: 1, 'qoder-cn': 1 });
    expect(summary.byProject[0]).toEqual({ project: 'alpha', count: 1 });
    expect(summary.byKind['episode']).toBe(1);
    expect(summary.byStatus['candidate']).toBe(3);
    expect(summary.distill.totalSessions).toBe(2);
    expect(summary.distill.byAgent).toEqual({ claude: 1, 'qoder-cn': 1 });
  });

  it('reports missing and malformed files with the path in the error', () => {
    expect(() => readMagpieMemory(path.join(os.tmpdir(), 'missing-magpie-memory.json')))
      .toThrow(MagpieSourceError);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-source-'));
    const badJson = path.join(dir, 'bad.json');
    fs.writeFileSync(badJson, '{not json');
    expect(() => readMagpieMemory(badJson)).toThrow(/bad\.json/);

    const badShape = path.join(dir, 'shape.json');
    fs.writeFileSync(badShape, JSON.stringify({ version: 1, memories: 'nope' }));
    expect(() => readMagpieMemory(badShape)).toThrow(/memories/);
  });

  it('scans a session index home and returns signals plus summary', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-home-'));
    fs.copyFileSync(memoryPath, path.join(home, 'memory.json'));
    fs.copyFileSync(distillPath, path.join(home, 'distill.json'));
    const result = scanMagpie(home);
    expect(result.signals).toHaveLength(3);
    expect(result.summary.total).toBe(3);
  });
});
