import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  MagpieDistillFile,
  MagpieMemoryFile,
  MagpieMemoryRecord,
  MagpieProject,
  MagpieScanResult,
  MagpieScanSummary,
  MagpieSignal,
  MagpieSourceRef,
} from './types.js';

export class MagpieSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MagpieSourceError';
  }
}

export function resolveMagpieHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['MAGPIE_HOME'] ?? path.join(os.homedir(), '.config', 'magpie');
}

function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new MagpieSourceError(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new MagpieSourceError(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function projectForScope(
  scope: string,
  projects: Record<string, MagpieProject>,
): { key: string; name: string; dir: string | null } {
  if (scope.startsWith('project:dir:')) {
    const rawPath = scope.slice('project:dir:'.length);
    const normalized = rawPath.replace(/\\/g, '/');
    const key = `dir:${normalized}`;
    const project = projects[key] ?? Object.values(projects).find((candidate) =>
      (candidate.roots ?? []).some((root) => root.replace(/\\/g, '/') === normalized),
    );
    return {
      key: project?.key ?? key,
      name: project?.name ?? path.basename(normalized),
      dir: project?.roots?.[0] ?? rawPath,
    };
  }
  if (scope === 'global') return { key: 'global', name: 'global', dir: null };
  return { key: scope, name: scope, dir: null };
}

function normalizeSource(value: unknown): MagpieSourceRef | null {
  const source = asRecord(value);
  if (!source) return null;
  const agent = String(source['agent'] ?? '');
  const session = String(source['session'] ?? '');
  const dir = String(source['dir'] ?? '');
  const quote = String(source['quote'] ?? '');
  const at = String(source['at'] ?? '');
  if (!agent && !session && !quote) return null;
  return { agent, session, dir, quote, at };
}

export function readMagpieMemory(filePath: string): MagpieMemoryFile {
  const data = asRecord(readJson(filePath));
  if (!data) {
    throw new MagpieSourceError(`Invalid memory file ${filePath}: expected an object`);
  }
  if (typeof data['version'] !== 'number') {
    throw new MagpieSourceError(`Invalid memory file ${filePath}: version must be a number`);
  }
  if (!Array.isArray(data['memories'])) {
    throw new MagpieSourceError(`Invalid memory file ${filePath}: memories must be an array`);
  }
  const projects = (asRecord(data['projects']) ?? {}) as Record<string, MagpieProject>;
  const memories = data['memories'].map((entry, index): MagpieMemoryRecord => {
    const memory = asRecord(entry);
    if (!memory) {
      throw new MagpieSourceError(`Invalid memory at index ${index} in ${filePath}`);
    }
    if (typeof memory['id'] !== 'string' || typeof memory['text'] !== 'string') {
      throw new MagpieSourceError(
        `Memory at index ${index} in ${filePath} needs string id and text`,
      );
    }
    const sources = Array.isArray(memory['sources'])
      ? memory['sources'].map(normalizeSource).filter((source): source is MagpieSourceRef => source !== null)
      : [];
    return {
      id: memory['id'],
      text: memory['text'],
      kind: String(memory['kind'] ?? ''),
      scope: String(memory['scope'] ?? ''),
      why: String(memory['why'] ?? ''),
      origin: String(memory['origin'] ?? ''),
      status: String(memory['status'] ?? ''),
      sources,
      created: String(memory['created'] ?? ''),
      updated: String(memory['updated'] ?? ''),
    };
  });
  return {
    version: data['version'],
    memories,
    projects,
    published: String(data['published'] ?? ''),
  };
}

export function readMagpieDistill(filePath: string): MagpieDistillFile {
  const data = asRecord(readJson(filePath));
  if (!data) {
    throw new MagpieSourceError(`Invalid distill file ${filePath}: expected an object`);
  }
  const doneRaw = asRecord(data['done']);
  if (!doneRaw) {
    throw new MagpieSourceError(`Invalid distill file ${filePath}: done must be an object`);
  }
  const done: Record<string, string> = {};
  for (const [key, value] of Object.entries(doneRaw)) {
    if (typeof value === 'string') done[key] = value;
  }
  return {
    done,
    last: typeof data['last'] === 'string' ? data['last'] : undefined,
    dream: data['dream'] === true,
  };
}

export function normalizeMemory(file: MagpieMemoryFile): MagpieSignal[] {
  return file.memories.map((memory) => {
    const project = projectForScope(memory.scope, file.projects);
    const agents = [...new Set(memory.sources.map((source) => source.agent).filter(Boolean))];
    const sessions = [...new Set(memory.sources.map((source) => source.session).filter(Boolean))];
    const contentHash = createHash('sha256')
      .update(JSON.stringify({ text: memory.text, why: memory.why, sources: memory.sources }))
      .digest('hex')
      .slice(0, 16);
    return {
      ...memory,
      projectKey: project.key,
      projectName: project.name,
      projectDir: project.dir,
      agents,
      sessions,
      contentHash,
    };
  });
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    if (value) acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

export function summarize(
  signals: MagpieSignal[],
  distill?: MagpieDistillFile,
): MagpieScanSummary {
  const byAgent = countBy(
    signals.flatMap((signal) => signal.sources.map((source) => source.agent)),
  );
  const byKind = countBy(signals.map((signal) => signal.kind));
  const byStatus = countBy(signals.map((signal) => signal.status));
  const projectCounts = countBy(signals.map((signal) => signal.projectName));
  const byProject = Object.entries(projectCounts)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
  const doneKeys = distill ? Object.keys(distill.done) : [];
  return {
    total: signals.length,
    byAgent,
    byProject,
    byKind,
    byStatus,
    distill: {
      totalSessions: doneKeys.length,
      byAgent: countBy(doneKeys.map((key) => key.split('/')[0] ?? 'unknown')),
      last: distill?.last ?? null,
    },
  };
}

export function scanMagpie(home = resolveMagpieHome()): MagpieScanResult {
  const memoryPath = path.join(home, 'memory.json');
  const distillPath = path.join(home, 'distill.json');
  const memory = readMagpieMemory(memoryPath);
  const distill = fs.existsSync(distillPath) ? readMagpieDistill(distillPath) : undefined;
  const signals = normalizeMemory(memory);
  return { home, memory, distill, signals, summary: summarize(signals, distill) };
}
