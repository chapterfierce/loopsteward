import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMagpieMemory } from '../magpie/magpie-source.js';
import type { MagpieProject } from '../magpie/types.js';

export interface ProjectIdentity {
  dir: string;
  name: string;
}

interface ProjectEntry extends ProjectIdentity {
  roots: string[];
}

export interface ProjectMap {
  entries: ProjectEntry[];
  resolve(projectDir: string): ProjectIdentity;
}

function normalizePath(value: string): string {
  return path.normalize(value.trim()).replace(/[\\/]+$/, '');
}

function pathKey(value: string): string {
  return normalizePath(value).replace(/\\/g, '/').toLowerCase();
}

function canonicalFromProject(project: MagpieProject): string {
  if (project.key.startsWith('dir:')) return project.key.slice(4);
  return project.roots?.[0] ?? project.key;
}

function buildMap(projects: Record<string, MagpieProject>): ProjectMap {
  const entries: ProjectEntry[] = [];
  for (const project of Object.values(projects)) {
    const dir = normalizePath(canonicalFromProject(project));
    const roots = [...new Set([dir, ...(project.roots ?? []).map(normalizePath)])];
    entries.push({
      dir,
      name: project.name || path.basename(dir),
      roots,
    });
  }
  entries.sort((left, right) => right.dir.length - left.dir.length);

  return {
    entries,
    resolve(projectDir: string): ProjectIdentity {
      const normalized = normalizePath(projectDir);
      const key = pathKey(normalized);

      const worktree = normalized.match(/^(.*?)[\\/]\.(?:claude|git)[\\/]worktrees[\\/]/i);
      if (worktree) {
        const rootKey = pathKey(worktree[1]);
        const entry = entries.find((candidate) =>
          candidate.roots.some((root) => pathKey(root) === rootKey));
        if (entry) return { dir: entry.dir, name: entry.name };
        const root = normalizePath(worktree[1]);
        return { dir: root, name: path.basename(root) || 'unknown' };
      }

      const exact = entries.find((entry) =>
        pathKey(entry.dir) === key || entry.roots.some((root) => pathKey(root) === key));
      if (exact) return { dir: exact.dir, name: exact.name };

      let current = normalized;
      for (let depth = 0; depth < 20; depth += 1) {
        if (fs.existsSync(path.join(current, '.git'))) {
          return { dir: current, name: path.basename(current) || 'unknown' };
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }

      for (const entry of entries) {
        for (const root of entry.roots) {
          const rootKey = pathKey(root);
          if (key === rootKey || key.startsWith(`${rootKey}/`)) {
            return { dir: entry.dir, name: entry.name };
          }
        }
      }
      return { dir: normalized, name: path.basename(normalized) || 'unknown' };
    },
  };
}

export function loadProjectMap(home = path.join(os.homedir(), '.config', 'magpie')): ProjectMap {
  const memoryPath = path.join(home, 'memory.json');
  if (!fs.existsSync(memoryPath)) return buildMap({});
  try {
    return buildMap(readMagpieMemory(memoryPath).projects);
  } catch {
    return buildMap({});
  }
}
