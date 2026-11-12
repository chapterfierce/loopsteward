import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPackageRoot } from './package-root.js';

export interface DataPathOptions {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppData?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveDataDir(options: DataPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.LOOPSTEWARD_DATA;
  if (explicit && explicit.trim()) return path.resolve(explicit);

  const root = path.resolve(options.packageRoot ?? findPackageRoot());
  if (fs.existsSync(path.join(root, 'src', 'loops'))) {
    return path.join(root, 'data');
  }

  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? os.homedir();
  if (platform === 'win32') {
    const localAppData = options.localAppData
      ?? env.LOCALAPPDATA
      ?? path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'LoopSteward');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'LoopSteward');
  }
  return path.join(home, '.local', 'share', 'loopsteward');
}

export function resolveDefaultDbPath(options: DataPathOptions = {}): string {
  return path.join(resolveDataDir(options), 'loops.db');
}
