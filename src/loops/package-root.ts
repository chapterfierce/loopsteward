import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAMES = new Set(['loopsteward', 'claw-task-service']);

export function findPackageRoot(start?: string): string {
  const origin = start ?? path.dirname(fileURLToPath(import.meta.url));
  let current = path.resolve(origin);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }
  for (;;) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name && PACKAGE_NAMES.has(parsed.name)) return current;
      } catch {
        // Keep walking: a malformed manifest is not a package root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`package root not found from ${origin}`);
    }
    current = parent;
  }
}
