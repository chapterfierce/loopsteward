#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const strict = args.includes('--strict');
const publishedFlag = args.indexOf('--published');
const publishedVersion = publishedFlag >= 0 ? args[publishedFlag + 1] : undefined;

const findings = [];
const info = [];

function add(level, rule, message, file, line) {
  findings.push({ level, rule, message, file, line });
}

function gitFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split('\0').filter(Boolean);
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function readText(relativePath) {
  const absolute = path.join(root, relativePath);
  const stat = fs.statSync(absolute);
  if (stat.size > 2 * 1024 * 1024) return undefined;
  const buffer = fs.readFileSync(absolute);
  if (isBinary(buffer)) return undefined;
  return buffer.toString('utf8');
}

function scanLines(relativePath, text, patterns) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      if (!pattern.regex.test(line)) continue;
      add(pattern.level, pattern.rule, pattern.message, relativePath, index + 1);
    }
  }
}

const textExtensions = new Set([
  '.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ts', '.tsx', '.js', '.mjs',
  '.cjs', '.ps1', '.cmd', '.sh', '.toml', '.ini', '.cfg', '.csv', '.html', '.css',
]);

const skipScan = new Set([
  'package-lock.json',
  'CHANGELOG.md',
]);

const internalMaterial = [
  { regex: /^docs\/(HANDOFF|market-landscape|requirements-retrospective|cleanup-review)/i, message: 'development notes must not be tracked in the public repo' },
  { regex: /^docs\/superpowers\//i, message: 'agent scratch notes must not be tracked in the public repo' },
  { regex: /^assets\/(drafts|concepts)\//i, message: 'design drafts must not be tracked in the public repo' },
  { regex: /\.tgz$/i, message: 'packed release artifacts must not be tracked' },
  { regex: /^(data|\.tmp|dist|node_modules)\//i, message: 'runtime or build output must not be tracked' },
  { regex: /(^|\/)\.env(\.|$)/i, message: 'environment files must not be tracked' },
  { regex: /\.(db|db-wal|db-shm|log)$/i, message: 'local data and logs must not be tracked' },
];

const namingPatterns = [
  { regex: /claw-task-service/i, level: 'error', rule: 'naming.stale', message: 'stale project name "claw-task-service"; use "loopsteward" in public artifacts' },
  { regex: /Claw Task Service/i, level: 'error', rule: 'naming.stale', message: 'stale product name "Claw Task Service"; use "LoopSteward"' },
  { regex: /Claw Task/i, level: 'error', rule: 'naming.stale', message: 'stale product name "Claw Task"; use "LoopSteward"' },
  { regex: /X-Claw-/i, level: 'error', rule: 'naming.stale', message: 'stale header prefix "X-Claw-"; rename before publishing' },
  { regex: /OpenLoops(?!Refresh)/i, level: 'warn', rule: 'naming.inconsistent', message: 'use "Open Loops" (two words) or "open-loops" (identifier)' },
];

const privacyPatterns = [
  { regex: /C:\\+Users\\+(?!(?:you|me|dev|user|alice|bob|x|test|example|name|username|<|%USERNAME%))[^\\\s"'`]+/i, level: 'error', rule: 'privacy.local-path', message: 'absolute Windows user path; replace with a placeholder or relative path' },
  { regex: /\/Users\/(?!(?:you|me|dev|user|alice|bob|x|test|example|name|username|<))[^/\s"'`]+/, level: 'error', rule: 'privacy.local-path', message: 'absolute macOS user path; replace with a placeholder or relative path' },
  { regex: /\/home\/(?!(?:you|me|dev|user|alice|bob|x|test|example|name|username|<))[^/\s"'`]+/, level: 'error', rule: 'privacy.local-path', message: 'absolute Linux user path; replace with a placeholder or relative path' },
  { regex: /\b127\.0\.0\.1:3425\b/, level: 'error', rule: 'privacy.internal-endpoint', message: 'private gateway endpoint must not appear in public docs' },
  { regex: /\bmarvis\/|deepseek-v4-1-flash/i, level: 'error', rule: 'privacy.internal-model', message: 'internal model route must not be a public default' },
  { regex: /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}\b/, level: 'error', rule: 'secret.api-key', message: 'possible API key' },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, level: 'error', rule: 'secret.github-token', message: 'possible GitHub token' },
  { regex: /\bnpm_[A-Za-z0-9]{30,}\b/, level: 'error', rule: 'secret.npm-token', message: 'possible npm token' },
  { regex: /\bAKIA[0-9A-Z]{16}\b/, level: 'error', rule: 'secret.aws-key', message: 'possible AWS access key' },
  { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, level: 'error', rule: 'secret.private-key', message: 'private key block' },
  { regex: /\bexample-project\b/i, level: 'error', rule: 'privacy.project-name', message: 'private project name; remove from public artifacts' },
  { regex: /\bexample-camera-app\b/i, level: 'error', rule: 'privacy.project-name', message: 'private project name; remove from public artifacts' },
  { regex: /[A-Za-z0-9._%+-]+@(?!example\.(com|org)|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, level: 'warn', rule: 'privacy.email', message: 'email address in public artifact; confirm it is intended' },
  { regex: /\bMagpie\b/, level: 'warn', rule: 'privacy.internal-brand', message: 'internal gateway brand; describe it generically in public docs' },
];

const skillPathPatterns = [
  { regex: /C:\\/i, level: 'warn', rule: 'skill.absolute-path', message: 'skill template hardcodes a Windows path; confirm the installer rewrites it' },
  { regex: /\/Users\/|\/home\//, level: 'warn', rule: 'skill.absolute-path', message: 'skill template hardcodes a user path; confirm the installer rewrites it' },
];

function checkTrackedFiles(files) {
  for (const relativePath of files) {
    for (const rule of internalMaterial) {
      if (rule.regex.test(relativePath)) {
        add('error', 'material.internal', rule.message, relativePath);
      }
    }
  }
}

function checkText(files) {
  const publicSurface = files.filter((file) => {
    if (skipScan.has(file)) return false;
    if (file.startsWith('assets/')) return false;
    if (file === 'package-lock.json') return false;
    return textExtensions.has(path.extname(file).toLowerCase()) || !path.extname(file);
  });

  for (const relativePath of publicSurface) {
    let text;
    try {
      text = readText(relativePath);
    } catch {
      continue;
    }
    if (!text) continue;
    scanLines(relativePath, text, privacyPatterns);
    const namingRuleSource = relativePath === 'docs/RELEASE_PROCESS.md'
      || relativePath === 'scripts/release-prep-check.mjs';
    if (!namingRuleSource && /^(README|package\.json|skills\/|scripts\/|docs\/)/.test(relativePath)) {
      scanLines(relativePath, text, namingPatterns);
    }
    if (/^skills\/.*SKILL\.md$/.test(relativePath)) {
      scanLines(relativePath, text, skillPathPatterns);
    }
  }
}

function checkPackageSurface() {
  const manifestPath = path.join(root, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    add('error', 'package.missing', 'package.json not found');
    return undefined;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  info.push({ key: 'package', value: `${manifest.name}@${manifest.version}` });

  const expectedFiles = ['dist', 'skills', 'scripts', 'docs/MCP.md', 'docs/RELEASE_PROCESS.md', 'README.md'];
  const actualFiles = manifest.files ?? [];
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    add(
      'error',
      'package.files',
      `package.json files should be ${JSON.stringify(expectedFiles)}, got ${JSON.stringify(actualFiles)}`,
      'package.json',
    );
  }
  if (!manifest.author) {
    add('warn', 'package.author', 'package.json has no author field', 'package.json');
  }
  if (!manifest.repository?.url) {
    add('error', 'package.repository', 'package.json has no repository URL', 'package.json');
  }

  const buildConfigPath = path.join(root, 'tsconfig.open-loops.json');
  if (!fs.existsSync(buildConfigPath)) {
    add('error', 'package.build-config', 'tsconfig.open-loops.json not found');
  } else {
    const buildConfig = fs.readFileSync(buildConfigPath, 'utf8');
    for (const forbidden of ['src/index.ts', 'intent-engine', 'tests']) {
      if (buildConfig.includes(forbidden)) {
        add('error', 'package.build-config', `runtime build must not include ${forbidden}`, 'tsconfig.open-loops.json');
      }
    }
  }

  const prepack = manifest.scripts?.prepack ?? '';
  if (!/clean/.test(prepack) || !/build:open-loops/.test(prepack)) {
    add('error', 'package.prepack', 'prepack must clean dist and rebuild only the runtime surface', 'package.json');
  }
  return manifest;
}

function checkVersion(manifest, files) {
  if (!manifest) return;
  const version = manifest.version ?? '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    add('error', 'version.semver', `invalid semver: ${version}`, 'package.json');
  }

  const manifestPath = path.join(root, '.release-please-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const releaseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (releaseManifest['.'] !== version) {
      add(
        'error',
        'version.manifest',
        `.release-please-manifest.json is ${releaseManifest['.']} but package.json is ${version}`,
        '.release-please-manifest.json',
      );
    }
  }

  let changelog = '';
  if (files.includes('CHANGELOG.md')) {
    changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    if (!changelog.includes(`## [${version}]`) && !changelog.includes(`## ${version}`)) {
      add('error', 'version.changelog', `CHANGELOG.md has no section for ${version}`, 'CHANGELOG.md');
    }
  }

  const firstCommit = spawnSync('git', ['log', '--reverse', '--format=%cI', '-1'], { cwd: root, encoding: 'utf8' });
  const firstDate = Date.parse(firstCommit.stdout.trim());
  const ageDays = Number.isFinite(firstDate) ? (Date.now() - firstDate) / 86400000 : Infinity;
  const major = Number(version.split('.')[0]);
  const hasEarlierPublicRelease = /^## \[?(?:0|1|2)\./m.test(changelog);
  if (ageDays < 60 && major >= 2 && !hasEarlierPublicRelease) {
    add(
      'warn',
      'version.inflation',
      `public history is ${Math.round(ageDays)} days old but version is ${version}; new packages should start at 0.x or 1.0.0`,
      'package.json',
    );
  }
}

function checkDocs() {
  const readmePath = path.join(root, 'README.md');
  if (!fs.existsSync(readmePath)) {
    add('error', 'docs.readme', 'README.md not found');
  } else {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const lines = readme.split(/\r?\n/).length;
    info.push({ key: 'readme_lines', value: lines });
    if (lines > 500) {
      add('warn', 'docs.readme-length', `README.md is ${lines} lines; move development history to a separate doc`, 'README.md');
    }
    if (/Legacy Milestones|^### M\d+ —/m.test(readme)) {
      add('warn', 'docs.legacy', 'README.md still contains legacy milestone history', 'README.md');
    }
    if (/intent-engine|src\/index\.ts|legacy HTTP/i.test(readme)) {
      add('warn', 'docs.legacy', 'README.md still documents the legacy service or engine', 'README.md');
    }
  }

  const community = [
    ['CONTRIBUTING.md', 'warn'],
    ['SECURITY.md', 'warn'],
    ['CODE_OF_CONDUCT.md', 'warn'],
    ['.github/PULL_REQUEST_TEMPLATE.md', 'warn'],
  ];
  for (const [file, level] of community) {
    if (!fs.existsSync(path.join(root, file))) {
      add(level, 'docs.community', `missing ${file}`, file);
    }
  }
  if (!fs.existsSync(path.join(root, '.github/ISSUE_TEMPLATE'))) {
    add('warn', 'docs.community', 'missing .github/ISSUE_TEMPLATE', '.github/ISSUE_TEMPLATE');
  }
}

function checkPublished(version) {
  if (!version) return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-audit-'));
  try {
    const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCli = [process.env.npm_execpath, bundledNpmCli].find((candidate) => candidate && fs.existsSync(candidate));
    const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const npmArgs = npmCli
      ? [npmCli, 'pack', `loopsteward@${version}`, '--silent']
      : ['pack', `loopsteward@${version}`, '--silent'];
    const packed = spawnSync(command, npmArgs, {
      cwd: tempDir,
      encoding: 'utf8',
      shell: !npmCli && process.platform === 'win32',
    });
    if (packed.status !== 0) {
      add('error', 'published.fetch', `could not download loopsteward@${version}: ${packed.stderr || packed.stdout}`);
      return;
    }
    const tarball = fs.readdirSync(tempDir).find((file) => file.endsWith('.tgz'));
    if (!tarball) {
      add('error', 'published.fetch', 'npm pack produced no tarball');
      return;
    }
    const listing = spawnSync('tar', ['-tzf', path.join(tempDir, tarball)], { encoding: 'utf8' });
    if (listing.status !== 0) {
      add('error', 'published.list', `could not list ${tarball}`);
      return;
    }
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    info.push({ key: 'published_entries', value: entries.length });
    for (const entry of entries) {
      if (entry.endsWith('.map')) {
        add('error', 'published.sourcemap', 'published tarball contains source maps', entry);
      }
      if (entry.includes('intent-engine') || entry.includes('dist/src/index.')) {
        add('error', 'published.legacy', 'published tarball contains legacy build output', entry);
      }
      if (/package\/(tests|data|\.tmp|docs\/(?!MCP\.md))/.test(entry)) {
        add('error', 'published.internal', 'published tarball contains non-public material', entry);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function summarize() {
  const errors = findings.filter((finding) => finding.level === 'error');
  const warnings = findings.filter((finding) => finding.level === 'warn');
  const grouped = new Map();
  for (const finding of findings) {
    const key = `${finding.level}:${finding.rule}`;
    const group = grouped.get(key) ?? { level: finding.level, rule: finding.rule, count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < 5) group.samples.push(finding);
    grouped.set(key, group);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: errors.length === 0, info, summary: { errors: errors.length, warnings: warnings.length }, findings, grouped: [...grouped.values()] }, null, 2));
    return;
  }

  console.log(`release-prep-check: ${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const item of info) console.log(`  ${item.key}: ${item.value}`);
  if (findings.length === 0) {
    console.log('  clean');
    return;
  }
  for (const group of [...grouped.values()].sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'error' ? -1 : 1))) {
    console.log(`\n[${group.level}] ${group.rule} (${group.count})`);
    for (const sample of group.samples) {
      const location = sample.file ? `${sample.file}${sample.line ? `:${sample.line}` : ''}` : '<repo>';
      console.log(`  - ${location}: ${sample.message}`);
    }
  }
}

try {
  const files = gitFiles();
  info.push({ key: 'tracked_files', value: files.length });
  checkTrackedFiles(files);
  checkText(files);
  const manifest = checkPackageSurface();
  checkVersion(manifest, files);
  checkDocs();
  checkPublished(publishedVersion);
  summarize();
  const hasErrors = findings.some((finding) => finding.level === 'error');
  const hasWarnings = findings.some((finding) => finding.level === 'warn');
  process.exitCode = hasErrors || (strict && hasWarnings) ? 1 : 0;
} catch (error) {
  console.error(`release-prep-check failed: ${error.message}`);
  process.exitCode = 2;
}
