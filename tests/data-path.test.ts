import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDataDir, resolveDefaultDbPath } from '../src/loops/data-path.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loopsteward-data-${label}-`));
  dirs.push(dir);
  return dir;
}

describe('data path', () => {
  it('keeps repository checkouts on their existing data directory', () => {
    const root = tempDir('repo');
    fs.mkdirSync(path.join(root, 'src', 'loops'), { recursive: true });

    expect(resolveDataDir({ packageRoot: root, env: {} })).toBe(path.join(root, 'data'));
    expect(resolveDefaultDbPath({ packageRoot: root, env: {} })).toBe(
      path.join(root, 'data', 'loops.db'),
    );
  });

  it('uses the Windows user data directory for installed packages', () => {
    const root = tempDir('installed');
    const localAppData = path.join(root, 'AppData', 'Local');

    expect(resolveDataDir({
      packageRoot: root,
      platform: 'win32',
      localAppData,
      env: {},
    })).toBe(path.join(localAppData, 'LoopSteward'));
  });

  it('uses platform conventions outside Windows', () => {
    const root = tempDir('platform');
    const home = path.join(root, 'home');

    expect(resolveDataDir({
      packageRoot: root,
      platform: 'darwin',
      homeDir: home,
      env: {},
    })).toBe(path.join(home, 'Library', 'Application Support', 'LoopSteward'));
    expect(resolveDataDir({
      packageRoot: root,
      platform: 'linux',
      homeDir: home,
      env: {},
    })).toBe(path.join(home, '.local', 'share', 'loopsteward'));
  });

  it('lets LOOPSTEWARD_DATA override the default location', () => {
    const root = tempDir('env');
    const custom = path.join(root, 'custom');

    expect(resolveDataDir({
      packageRoot: root,
      platform: 'win32',
      env: { LOOPSTEWARD_DATA: custom },
    })).toBe(custom);
  });
});
