import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoopStore } from '../src/loops/loop-store.js';
import { buildLoopDoctor, describeScheduledTask, inspectBuild } from '../src/loops/doctor.js';
import { renderOpenLoopsSkill, skillAgentTargets } from '../src/loops/skill-install.js';
import { installSessionPolicy } from '../src/loops/session-policy.js';

const dirs: string[] = [];
const sourcePath = path.join(process.cwd(), 'skills', 'open-loops', 'SKILL.md');

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-doctor-${label}-`));
  dirs.push(dir);
  return dir;
}

function installSkillCopies(home: string): void {
  const localAppData = path.join(home, 'AppData', 'Local');
  const content = renderOpenLoopsSkill(fs.readFileSync(sourcePath, 'utf8'), process.cwd());
  for (const target of skillAgentTargets({ homeDir: home, localAppData })) {
    fs.mkdirSync(path.dirname(target.target), { recursive: true });
    fs.writeFileSync(target.target, content, 'utf8');
  }
}

function check(report: ReturnType<typeof buildLoopDoctor>, key: string) {
  const found = report.checks.find((entry) => entry.key === key);
  if (!found) throw new Error(`missing check: ${key}`);
  return found;
}

function seedLoop(store: LoopStore, title: string, at: string) {
  return store.saveLoop(
    {
      title,
      nextAction: `next ${title}`,
      why: 'test',
      confidence: 0.8,
      sourceSignalIds: [`codex:${title}`],
    },
    {
      projectDir: 'C:/work/alpha',
      projectName: 'alpha',
      firstSeen: at,
      lastSeen: at,
    },
  ).loop;
}

describe('loop doctor', () => {
  it('reports a healthy database, fresh install, and the feedback gap', () => {
    const dir = tempDir('healthy');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(report.ok).toBe(true);
    expect(check(report, 'database').status).toBe('ok');
    expect(check(report, 'ingest').status).toBe('warn');
    expect(check(report, 'sources')).toMatchObject({
      status: 'ok',
      detail: '暂无信号',
    });
    expect(check(report, 'feedback').status).toBe('warn');
    expect(check(report, 'review-cycle')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('尚未开始'),
    });
    expect(check(report, 'skills').detail).toContain('6/6');
    expect(report.warnings.some((warning) => warning.includes('真实反馈'))).toBe(true);
  });

  it('reports per-agent signal freshness', () => {
    const dir = tempDir('sources');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.saveSignal({
      id: 'codex:s1:m1',
      source: 'session',
      sourceId: 's1',
      messageId: 'm1',
      agent: 'codex',
      role: 'assistant',
      text: 'fresh source',
      projectDir: 'C:/work/alpha',
      capturedAt: '2026-11-11T10:00:00.000Z',
      contentHash: 'm1',
    });
    store.saveSignal({
      id: 'claude:s1:m1',
      source: 'session',
      sourceId: 's2',
      messageId: 'c1',
      agent: 'claude',
      role: 'assistant',
      text: 'older source',
      projectDir: 'C:/work/alpha',
      capturedAt: '2026-11-10T10:00:00.000Z',
      contentHash: 'c1',
    });
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    const sources = check(report, 'sources');
    expect(sources.status).toBe('ok');
    expect(sources.detail).toContain('codex 2.0 小时');
    expect(sources.detail).toContain('claude 1.1 天');
  });

  it('warns when a weekly review pass has stalled', () => {
    const dir = tempDir('stalled-review');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    const at = '2026-11-11T10:00:00.000Z';
    const first = seedLoop(store, 'first', at);
    seedLoop(store, 'second', at);
    seedLoop(store, 'third', at);
    store.recordPresentation([first.id], '2026-10-20T12:00:00.000Z', 'review', 'review');
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(check(report, 'review-cycle')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('已看 1/3，剩余 2'),
    });
    expect(check(report, 'review-cycle').detail).toContain('没有继续');
    expect(report.warnings.some((warning) => warning.includes('周回顾轮次'))).toBe(true);
  });

  it('reports an active review pass without warning', () => {
    const dir = tempDir('active-review');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    const at = '2026-11-11T10:00:00.000Z';
    const first = seedLoop(store, 'first', at);
    seedLoop(store, 'second', at);
    store.recordPresentation([first.id], '2026-11-11T11:00:00.000Z', 'review', 'review');
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(check(report, 'review-cycle')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('已看 1/2，剩余 1'),
    });
    expect(check(report, 'review-cycle').detail).not.toContain('没有继续');
  });

  it('warns when presentations are dated in the future', () => {
    const dir = tempDir('future-presentation');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.recordPresentation(['loop_future'], '2026-11-13T12:00:00.000Z');
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(check(report, 'presentation-integrity')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('未来时间'),
    });
    expect(report.warnings.some((warning) => warning.includes('未来时间'))).toBe(true);
  });

  it('does not warn for presentations within the clock-skew tolerance', () => {
    const dir = tempDir('near-future-presentation');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.recordPresentation(['loop_near_future'], '2026-11-11T12:02:00.000Z');
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(check(report, 'presentation-integrity')).toMatchObject({
      status: 'ok',
      detail: '时间戳正常',
    });
  });

  it('fails when the database is missing', () => {
    const dir = tempDir('missing');
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath: path.join(dir, 'missing.db'),
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(report.ok).toBe(false);
    expect(check(report, 'database').status).toBe('fail');
  });

  it('can treat a missing database as a first-run warning', () => {
    const dir = tempDir('first-run');
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath: path.join(dir, 'missing.db'),
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      allowMissingDatabase: true,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(report.ok).toBe(true);
    expect(check(report, 'database')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('尚未初始化'),
    });
  });

  it('accepts a prebuilt package without source files', () => {
    const dir = tempDir('installed-build');
    const distPath = path.join(dir, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(distPath, '// built\n', 'utf8');

    const check = inspectBuild(
      distPath,
      path.join(dir, 'src'),
      new Date('2026-11-11T12:00:00.000Z'),
    );

    expect(check.status).toBe('ok');
    expect(check.detail).toContain('已安装包');
  });

  it('warns when an installed skill copy drifts from the repository', () => {
    const dir = tempDir('stale-skill');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);
    const codexTarget = skillAgentTargets({
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
    }).find((target) => target.agent === 'codex')!;
    fs.appendFileSync(codexTarget.target, '\nstale\n');

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(report.ok).toBe(true);
    expect(check(report, 'skills').status).toBe('warn');
    expect(check(report, 'skills').detail).toContain('codex: 不一致');
  });

  it.skipIf(process.platform !== 'win32')('warns when an installed skill points at a missing wrapper', () => {
    const dir = tempDir('missing-wrapper');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    const movedPackageRoot = path.join(dir, 'moved-package');
    const content = renderOpenLoopsSkill(fs.readFileSync(sourcePath, 'utf8'), movedPackageRoot);
    for (const target of skillAgentTargets({ homeDir: home, localAppData })) {
      fs.mkdirSync(path.dirname(target.target), { recursive: true });
      fs.writeFileSync(target.target, content, 'utf8');
    }

    const report = buildLoopDoctor({
      packageRoot: movedPackageRoot,
      dbPath,
      home,
      localAppData,
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scriptPath: path.join(process.cwd(), 'scripts', 'open-loops.ps1'),
      scheduledTask: false,
      buildCheck: false,
      mcpCheck: false,
      sessionPolicy: false,
    });

    expect(report.ok).toBe(true);
    expect(check(report, 'skills').status).toBe('warn');
    expect(check(report, 'skills').detail).toContain('wrapper 不存在');
  });

  it('warns when the oldest reconcile cache row exceeds the retention window', () => {
    const dir = tempDir('stale-cache');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.setReconcileCache('codex:s1', 'hash', [], '2026-09-01T00:00:00.000Z');
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    });

    expect(check(report, 'cache').status).toBe('warn');
    expect(check(report, 'cache').detail).toContain('保留期');
  });

  it('reports a missing scheduled refresh task without crashing', () => {
    const dir = tempDir('missing-task');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);

    const report = buildLoopDoctor({
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      taskName: 'OpenLoopsRefresh-Doctor-Test-Missing',
      buildCheck: false,
    });

    const expected = process.platform === 'win32' ? 'warn' : 'ok';
    expect(check(report, 'scheduled-task').status).toBe(expected);
  });

  it('warns when the scheduled task points at another installation', () => {
    const result = describeScheduledTask(
      'Ready',
      0,
      '2026-11-11T11:00:00.000Z',
      new Date('2026-11-11T12:00:00.000Z'),
      undefined,
      {
        expectedScript: 'C:\\new-install\\scripts\\refresh-open-loops.ps1',
        action: 'powershell.exe -NoProfile -File "C:\\old-repo\\scripts\\refresh-open-loops.ps1"',
      },
    );

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('任务指向其他安装');
    expect(result.detail).toContain('old-repo');
  });

  it('accepts a scheduled task that points at the current installation', () => {
    const result = describeScheduledTask(
      'Ready',
      0,
      '2026-11-11T11:00:00.000Z',
      new Date('2026-11-11T12:00:00.000Z'),
      undefined,
      {
        expectedScript: 'C:\\new-install\\scripts\\refresh-open-loops.ps1',
        action: 'powershell.exe -NoProfile -File "C:\\New-Install\\scripts\\refresh-open-loops.ps1"',
      },
    );

    expect(result.status).toBe('ok');
  });

  it('reports a missing session policy and clears it after installation', () => {
    const dir = tempDir('session-policy');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);
    const common = {
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
    };

    const before = buildLoopDoctor(common);
    expect(check(before, 'session-policy').status).toBe('warn');

    installSessionPolicy({
      homeDir: home,
      scriptPath: path.join(process.cwd(), 'scripts', 'open-loops.mjs'),
    });
    const after = buildLoopDoctor(common);
    expect(check(after, 'session-policy')).toMatchObject({
      status: 'ok',
      detail: '4/4 已安装',
    });
  });

  it('warns when the compiled CLI is older than the sources', () => {
    const dir = tempDir('build-freshness');
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    const home = path.join(dir, 'home');
    installSkillCopies(home);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const sourceFile = path.join(srcDir, 'cli.ts');
    fs.writeFileSync(sourceFile, 'export {};\n');
    const distPath = path.join(dir, 'dist', 'src', 'loops', 'cli.js');
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(distPath, '// built\n');
    const old = new Date('2026-11-11T10:00:00.000Z');
    const fresh = new Date('2026-11-11T11:00:00.000Z');
    fs.utimesSync(distPath, old, old);
    fs.utimesSync(sourceFile, fresh, fresh);

    const common = {
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      sessionPolicy: false,
      buildCheck: true,
      distPath,
      srcDir,
    };
    const stale = buildLoopDoctor(common);
    expect(check(stale, 'build').status).toBe('warn');
    expect(check(stale, 'build').detail).toContain('源码比构建产物新');

    fs.utimesSync(sourceFile, old, old);
    fs.utimesSync(distPath, fresh, fresh);
    const freshReport = buildLoopDoctor(common);
    expect(check(freshReport, 'build').status).toBe('ok');
    expect(check(freshReport, 'build').detail).toContain('dist 与源码一致');
  });
});

describe('mcp client check', () => {
  function baseOptions(dir: string, home: string) {
    const dbPath = path.join(dir, 'loops.db');
    const store = new LoopStore(dbPath);
    store.close();
    return {
      dbPath,
      home,
      localAppData: path.join(home, 'AppData', 'Local'),
      now: new Date('2026-11-11T12:00:00.000Z'),
      skillSourcePath: sourcePath,
      scheduledTask: false,
      buildCheck: false,
      sessionPolicy: false,
      mcpProjectDir: dir,
    };
  }

  it('treats MCP as optional when no client config exists', () => {
    const dir = tempDir('mcp-none');
    const home = path.join(dir, 'home');
    const report = buildLoopDoctor(baseOptions(dir, home));

    expect(check(report, 'mcp')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('未配置 MCP 客户端'),
    });
  });

  it('validates codex, claude, and cursor server paths', () => {
    const dir = tempDir('mcp-valid');
    const home = path.join(dir, 'home');
    const serverPath = path.join(dir, 'dist', 'src', 'mcp', 'server.js');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, '// server\n');
    const codexConfig = path.join(dir, 'codex.toml');
    const claudeConfig = path.join(dir, '.mcp.json');
    const cursorConfig = path.join(dir, 'cursor.json');
    fs.writeFileSync(
      codexConfig,
      `[mcp_servers.loopsteward]\ncommand = "node"\nargs = [${JSON.stringify(serverPath)}]\n`,
    );
    const config = { mcpServers: { loopsteward: { command: 'node', args: [serverPath] } } };
    fs.writeFileSync(claudeConfig, JSON.stringify(config));
    fs.writeFileSync(cursorConfig, JSON.stringify(config));

    const report = buildLoopDoctor({
      ...baseOptions(dir, home),
      codexConfig,
      claudeConfig,
      cursorConfig,
    });

    expect(check(report, 'mcp')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('codex / claude / cursor'),
    });
  });

  it('warns when a configured server path is missing', () => {
    const dir = tempDir('mcp-missing');
    const home = path.join(dir, 'home');
    const codexConfig = path.join(dir, 'codex.toml');
    fs.writeFileSync(
      codexConfig,
      `[mcp_servers.loopsteward]\ncommand = "node"\nargs = [${JSON.stringify(
        path.join(dir, 'missing.js'),
      )}]\n`,
    );

    const report = buildLoopDoctor({ ...baseOptions(dir, home), codexConfig });

    expect(check(report, 'mcp')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('server 路径不存在'),
    });
  });
});

describe('scheduled task detail', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');

  it('shows a running task without exposing the 267009 scheduler code', () => {
    const result = describeScheduledTask('Running', 267009, '2026-11-11T11:59:00.000Z', now);

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('正在运行');
    expect(result.detail).not.toContain('267009');
  });

  it('warns when a ready task still carries the running code', () => {
    const result = describeScheduledTask('Ready', 267009, '2026-11-11T11:59:00.000Z', now);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('未正常退出');
  });

  it('fails on a real non-zero result', () => {
    const result = describeScheduledTask('Ready', 1, '2026-11-11T11:59:00.000Z', now);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('结果 1');
  });

  it('warns when the last run was interrupted with a control-c status', () => {
    const result = describeScheduledTask('Ready', 3221225786, '2026-11-11T11:59:00.000Z', now);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('0xC000013A');
    expect(result.detail).not.toContain('结果 3221225786');
  });

  it('warns when the last run is older than six hours', () => {
    const result = describeScheduledTask('Ready', 0, '2026-11-11T05:00:00.000Z', now);

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('超过 2 小时周期');
  });

  it('stays ok for a recent zero result', () => {
    const result = describeScheduledTask('Ready', 0, '2026-11-11T11:59:00.000Z', now);

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('结果 0');
  });
});
