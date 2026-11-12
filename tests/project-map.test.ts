import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectMap } from '../src/loops/project-map.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadProjectMap', () => {
  it('maps worktrees and child directories back to the project root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-map-'));
    tempDirs.push(home);
    const parent = path.join(home, 'project');
    const child = path.join(parent, 'example-project');
    fs.writeFileSync(path.join(home, 'memory.json'), JSON.stringify({
      version: 1,
      memories: [],
      projects: {
        'dir:C:/work/alpha': {
          key: 'dir:C:/work/alpha',
          name: 'alpha',
          roots: [
            'C:\\work\\alpha',
            'C:\\work\\alpha\\.claude\\worktrees\\feature-a',
          ],
        },
        [`dir:${parent.replace(/\\/g, '/')}`]: {
          key: `dir:${parent.replace(/\\/g, '/')}`,
          name: 'parent',
          roots: [parent],
        },
      },
    }));
    fs.mkdirSync(path.join(child, '.git'), { recursive: true });

    const map = loadProjectMap(home);
    expect(map.resolve('C:\\work\\alpha\\.claude\\worktrees\\feature-a\\src')).toEqual({
      dir: path.normalize('C:/work/alpha'),
      name: 'alpha',
    });
    expect(map.resolve('C:\\work\\beta')).toEqual({
      dir: path.normalize('C:\\work\\beta'),
      name: 'beta',
    });
    expect(map.resolve(child)).toEqual({
      dir: path.normalize(child),
      name: 'example-project',
    });
    expect(map.resolve('C:\\work\\example-project\\.claude\\worktrees\\great-tesla')).toEqual({
      dir: path.normalize('C:\\work\\example-project'),
      name: 'example-project',
    });
  });
});
