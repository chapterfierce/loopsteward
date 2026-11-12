import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPackageRoot } from '../src/loops/package-root.js';
import { installOpenLoopsSkill } from '../src/loops/skill-install.js';

describe('package root', () => {
  it('finds the package root from the module location', () => {
    const root = findPackageRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: string;
    };
    expect(pkg.name).toBe('loopsteward');
    expect(fs.existsSync(path.join(root, 'skills', 'open-loops', 'SKILL.md'))).toBe(true);
  });

  it('walks up from a nested directory', () => {
    const root = findPackageRoot();
    expect(findPackageRoot(path.join(root, 'src', 'loops'))).toBe(root);
  });

  it('throws when no package root is found', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-root-'));
    try {
      expect(() => findPackageRoot(temp)).toThrow(/package root not found/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('finds the default skill source when the process cwd is elsewhere', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-cwd-'));
    const original = process.cwd();
    process.chdir(temp);
    try {
      const result = installOpenLoopsSkill({ destinationPath: path.join(temp, 'SKILL.md') });
      expect(result.action).toBe('installed');
      expect(fs.existsSync(path.join(temp, 'SKILL.md'))).toBe(true);
    } finally {
      process.chdir(original);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
