#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expectedVersion = manifest.version;
const keep = process.argv.includes('--keep');
const tarballFlag = process.argv.indexOf('--tarball');
const explicitTarball = tarballFlag >= 0 ? process.argv[tarballFlag + 1] : undefined;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath;
let tempDir;
let succeeded = false;

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: options.shell ?? false,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNpm(args, cwd) {
  if (npmCli && fs.existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], cwd);
  }
  return run(npm, args, cwd, { shell: process.platform === 'win32' });
}

async function verifyMcp(serverPath, dbPath, projectDir) {
  const child = spawn(process.execPath, [serverPath, '--db', dbPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) break;
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === 'number') responses.set(message.id, message);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'loopsteward-package-verify', version: '1.0.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'loops_closing', arguments: { projectDir } },
  });

  try {
    const deadline = Date.now() + 15000;
    while (!(responses.has(1) && responses.has(2) && responses.has(3))) {
      if (Date.now() > deadline) {
        throw new Error(`MCP handshake timed out${stderr ? `: ${stderr.trim()}` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const init = responses.get(1);
    const tools = responses.get(2);
    const closing = responses.get(3);
    assert(init.result?.serverInfo?.version === expectedVersion, 'MCP version mismatch');
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert(
      names.join(',') === 'loops_closing,loops_context,loops_get,loops_search',
      `unexpected MCP tools: ${names.join(',')}`,
    );
    const payload = JSON.parse(closing.result.content[0].text);
    assert(payload.total === 1, `expected 1 closing item, got ${payload.total}`);
    assert(/^[0-9a-f]{8}$/.test(payload.items[0].ref ?? ''), 'closing item is missing a ref');
    return { tools: names, ref: payload.items[0].ref };
  } finally {
    child.kill();
  }
}

try {
  const tarball = explicitTarball
    ? path.resolve(explicitTarball)
    : path.join(root, `loopsteward-${expectedVersion}.tgz`);
  if (!explicitTarball) runNpm(['pack'], root);
  assert(fs.existsSync(tarball), `tarball not found: ${tarball}`);

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopsteward-verify-'));
  runNpm(['init', '-y'], tempDir);
  runNpm(['install', tarball, '--no-audit', '--no-fund'], tempDir);

  const installedRoot = path.join(tempDir, 'node_modules', 'loopsteward');
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
  );
  assert(installedManifest.version === expectedVersion, 'installed package version mismatch');
  assert(
    installedManifest.main === 'dist/src/loops/index.js',
    `unexpected package main: ${installedManifest.main}`,
  );
  assert(
    installedManifest.exports?.['.'] === './dist/src/loops/index.js',
    'package exports do not point at the public entry',
  );
  assert(
    installedManifest.bin?.['loopsteward-mcp'],
    'package is missing the loopsteward-mcp bin',
  );

  const importScript = path.join(tempDir, 'verify-import.mjs');
  fs.writeFileSync(
    importScript,
    [
      "import * as api from 'loopsteward';",
      "console.log(JSON.stringify({",
      "  hasIngest: typeof api.ingestRecentSessions === 'function',",
      "  hasStore: typeof api.LoopStore === 'function',",
      '}));',
      '',
    ].join('\n'),
    'utf8',
  );
  const importOutput = run(process.execPath, [importScript], tempDir);
  assert(!/LoopSteward \(守环\)|Usage:/.test(importOutput), 'importing the package printed CLI usage');
  const imported = JSON.parse(importOutput);
  assert(imported.hasIngest, 'package entry does not export ingestRecentSessions');
  assert(imported.hasStore, 'package entry does not export LoopStore');

  const { LoopStore } = await import(
    pathToFileURL(path.join(installedRoot, 'dist', 'src', 'loops', 'loop-store.js')).href
  );
  const projectDir = path.join(tempDir, 'project');
  const dbPath = path.join(tempDir, 'verify.db');
  fs.mkdirSync(projectDir, { recursive: true });
  const store = new LoopStore(dbPath);
  try {
    const { loop } = store.saveLoop(
      {
        title: 'package verification loop',
        nextAction: 'confirm the packaged CLI can read it',
        why: 'release smoke test',
        confidence: 0.9,
        sourceSignalIds: ['verify-signal'],
      },
      {
        projectDir,
        projectName: 'package-verify',
        firstSeen: '2026-11-10T10:00:00.000Z',
        lastSeen: '2026-11-10T10:00:00.000Z',
      },
    );
    store.recordPresentation([loop.id], '2026-11-10T11:00:00.000Z', 'hot', 'hot');
  } finally {
    store.close();
  }

  const cliPath = path.join(installedRoot, 'dist', 'src', 'loops', 'cli.js');

  const emptyHome = path.join(tempDir, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const setup = JSON.parse(run(
    process.execPath,
    [
      cliPath,
      'setup',
      '--dry-run',
      '--json',
      '--home', emptyHome,
      '--local-appdata', path.join(emptyHome, 'AppData', 'Local'),
    ],
    tempDir,
  ));
  assert(setup.ok === true, `setup dry-run failed on an empty home: ${JSON.stringify(setup.steps)}`);
  assert(
    setup.steps.find((step) => step.key === 'skill')?.status === 'skipped',
    'setup should skip skill installation when no agent is detected',
  );
  assert(!fs.existsSync(path.join(emptyHome, '.codex')), 'setup created a dead agent directory');

  const agentHome = path.join(tempDir, 'agent-home');
  fs.mkdirSync(path.join(agentHome, '.codex'), { recursive: true });
  const skillInstall = JSON.parse(run(
    process.execPath,
    [
      cliPath,
      'install-skill',
      '--agents', 'codex',
      '--home', agentHome,
      '--json',
    ],
    tempDir,
  ));
  assert(
    skillInstall.results?.[0]?.action === 'installed',
    'install-skill did not install the Codex copy',
  );
  const installedSkill = fs.readFileSync(
    path.join(agentHome, '.codex', 'skills', 'open-loops', 'SKILL.md'),
    'utf8',
  );
  assert(!installedSkill.includes('C:\\loopsteward'), 'installed skill still contains the old hard-coded path');
  assert(
    installedSkill.includes(path.join(installedRoot, 'scripts', 'open-loops.mjs')),
    'installed skill does not point at the cross-platform wrapper',
  );
  assert(
    fs.existsSync(path.join(installedRoot, 'scripts', 'open-loops.mjs')),
    'packaged wrapper script is missing',
  );

  const ingestDbPath = path.join(tempDir, 'ingest.db');
  const ingestProject = path.join(tempDir, 'ingest-project');
  fs.mkdirSync(ingestProject, { recursive: true });
  const packagedApi = await import(
    pathToFileURL(path.join(installedRoot, 'dist', 'src', 'loops', 'index.js')).href
  );
  const ingestSummary = await packagedApi.ingestRecentSessions({
    dbPath: ingestDbPath,
    discover: () => [{
      agent: 'codex',
      sessionId: 'package-verify',
      title: 'package verify',
      projectDir: ingestProject,
      lastActive: '2026-11-10T10:01:00.000Z',
      sourceFile: 'package-verify.jsonl',
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: '下一步补错误提示',
          timestamp: '2026-11-10T10:00:00.000Z',
        },
        {
          id: 'm2',
          role: 'assistant',
          text: '我接下来补错误提示。',
          timestamp: '2026-11-10T10:01:00.000Z',
        },
      ],
    }],
    extract: async () => [{
      title: '补错误提示',
      nextAction: '补错误提示',
      why: '还没补',
      confidence: 0.9,
      sourceMessageIds: ['m1', 'm2'],
    }],
  });
  assert(ingestSummary.errors.length === 0, `packaged ingest errors: ${ingestSummary.errors.join('; ')}`);
  assert(ingestSummary.loopsCreated === 1, `packaged ingest created ${ingestSummary.loopsCreated} loops`);
  const ingestStore = new LoopStore(ingestDbPath);
  try {
    assert(ingestStore.listLoops({ status: 'open' }).length === 1, 'packaged ingest did not persist the loop');
  } finally {
    ingestStore.close();
  }

  const closing = JSON.parse(
    run(
      process.execPath,
      [cliPath, 'closing', '--db', dbPath, '--project', projectDir, '--json'],
      tempDir,
    ),
  );
  assert(closing.total === 1, `expected 1 closing item, got ${closing.total}`);
  assert(/^[0-9a-f]{8}$/.test(closing.items[0].ref ?? ''), 'CLI closing item is missing a ref');

  const mcp = await verifyMcp(
    path.join(installedRoot, 'dist', 'src', 'mcp', 'server.js'),
    dbPath,
    projectDir,
  );
  succeeded = true;
  console.log(
    `verify-package ok: version=${expectedVersion} closing.ref=${closing.items[0].ref} mcp.tools=${mcp.tools.length}`,
  );
} catch (error) {
  console.error(`verify-package failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (tempDir && (succeeded || !keep)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } else if (tempDir) {
    console.error(`kept temporary directory: ${tempDir}`);
  }
}
