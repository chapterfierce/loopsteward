import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDefaultDbPath } from '../src/loops/data-path.js';
import { LoopStore } from '../src/loops/loop-store.js';
import { formatSetup, runSetup } from '../src/loops/setup.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loops-setup-${label}-`));
  dirs.push(dir);
  return dir;
}

function repoFixture(label: string, built = true, withHermes = true, withAgents = true): string {
  const root = tempDir(label);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'open-loops.ps1'), 'exit 0\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'open-loops.mjs'), '// wrapper\n', 'utf8');
  fs.mkdirSync(path.join(root, 'skills', 'open-loops'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'open-loops', 'SKILL.md'),
    '# Test skill\n\nRun scripts/open-loops.mjs.\n',
    'utf8',
  );
  if (built) {
    fs.mkdirSync(path.join(root, 'dist', 'src', 'loops'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'src', 'loops', 'cli.js'), '// built\n', 'utf8');
  }
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (withAgents) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.zcode'), { recursive: true });
  }
  if (withHermes) {
    fs.mkdirSync(path.join(home, 'AppData', 'Local', 'hermes'), { recursive: true });
  }
  return root;
}

function createLoopDatabase(root: string, label: string): string {
  const dbPath = path.join(root, 'old', `${label}.db`);
  const store = new LoopStore(dbPath);
  store.saveLoop(
    {
      title: '导入的旧循环',
      nextAction: '确认导入成功',
      why: '验证 setup --import-db',
      confidence: 0.9,
      sourceSignalIds: [],
    },
    {
      projectDir: path.join(root, 'project'),
      projectName: 'fixture',
      firstSeen: '2026-11-01T00:00:00.000Z',
      lastSeen: '2026-11-01T00:00:00.000Z',
    },
  );
  store.close();
  return dbPath;
}

describe('loops:setup', () => {
  it('plans build, skill, and policy steps without writing in dry-run', async () => {
    const root = repoFixture('dry-run', false);
    const home = path.join(root, 'home');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
      dryRun: true,
      schedule: true,
      ingest: true,
    });

    expect(result.ok).toBe(true);
    expect(result.doctor).toBeUndefined();
    expect(result.steps.find((step) => step.key === 'build')?.status).toBe('planned');
    expect(result.steps.find((step) => step.key === 'skill')?.status).toBe('planned');
    expect(result.steps.find((step) => step.key === 'policy')?.status).toBe('planned');
    expect(result.steps.find((step) => step.key === 'schedule')?.status)
      .toBe(process.platform === 'win32' ? 'planned' : 'skipped');
    expect(result.steps.find((step) => step.key === 'ingest')?.status).toBe('planned');
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(false);
    expect(formatSetup(result)).toContain('结论：初始化完成。');
  });

  it('installs an explicitly selected skill and policy, and skips build when built', async () => {
    const root = repoFixture('install');
    const home = path.join(root, 'home');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
      agents: ['codex'],
      runBuild: () => {
        throw new Error('build should not run');
      },
    });

    expect(result.steps.find((step) => step.key === 'build')?.status).toBe('skipped');
    expect(result.steps.find((step) => step.key === 'skill')?.status).toBe('done');
    expect(result.steps.find((step) => step.key === 'policy')?.status).toBe('done');
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'open-loops', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain('open-loops:begin');
    expect(fs.existsSync(path.join(home, '.zcode', 'AGENTS.md'))).toBe(false);
  });

  it('installs into every detected agent by default', async () => {
    const root = repoFixture('install-hermes');
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      runBuild: () => {
        throw new Error('build should not run');
      },
    });

    expect(result.steps.find((step) => step.key === 'skill')?.status).toBe('done');
    expect(result.steps.find((step) => step.key === 'policy')?.status).toBe('done');
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'open-loops', 'SKILL.md')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8'))
      .toContain('open-loops:begin');
    expect(fs.readFileSync(path.join(home, '.zcode', 'AGENTS.md'), 'utf8'))
      .toContain('open-loops:begin');
    expect(
      fs.existsSync(path.join(localAppData, 'hermes', 'skills', 'open-loops', 'SKILL.md')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(localAppData, 'hermes', 'SOUL.md'), 'utf8'))
      .toContain('open-loops:begin');
    expect(result.doctor?.checks.find((check) => check.key === 'skills')?.detail)
      .toContain('2/2');
    expect(result.doctor?.checks.find((check) => check.key === 'session-policy')?.detail)
      .toContain('3/3');
  });

  it('skips agent installation when no agent directory exists', async () => {
    const root = repoFixture('missing-agents', true, false, false);
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      runBuild: () => {
        throw new Error('build should not run');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.key === 'skill')).toMatchObject({
      status: 'skipped',
    });
    expect(result.steps.find((step) => step.key === 'policy')).toMatchObject({
      status: 'skipped',
    });
    expect(result.steps.find((step) => step.key === 'skill')?.detail)
      .toContain('未检测到已安装的 Agent');
    expect(formatSetup(result)).toContain('结论：初始化完成。');
  });

  it('keeps an empty dry run successful without creating directories', async () => {
    const root = repoFixture('empty-dry-run', true, false, false);
    const home = path.join(root, 'home');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.key === 'skill')?.status).toBe('skipped');
    expect(result.steps.find((step) => step.key === 'policy')?.status).toBe('skipped');
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('records a build failure and returns a non-zero result', async () => {
    const root = repoFixture('build-fail', false);
    const home = path.join(root, 'home');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
      runBuild: () => {
        throw new Error('tsc failed');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.key === 'build')).toMatchObject({
      status: 'failed',
      detail: 'tsc failed',
    });
    expect(formatSetup(result)).toContain('结论：有步骤失败');
  });

  it('returns failure when the health check finds a blocking problem', async () => {
    const root = repoFixture('doctor-fail');
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    const target = resolveDefaultDbPath({ packageRoot: root, homeDir: home, localAppData });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not sqlite', 'utf8');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      runBuild: () => {
        throw new Error('build should not run');
      },
    });

    expect(result.steps.some((step) => step.status === 'failed')).toBe(false);
    expect(result.doctor?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(formatSetup(result)).toContain('结论：健康检查未通过');
  });

  it('imports an existing Open Loops database before installing skills', async () => {
    const root = repoFixture('import');
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    const source = createLoopDatabase(root, 'old');
    const target = resolveDefaultDbPath({ packageRoot: root, homeDir: home, localAppData });

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      agents: [],
      importDb: source,
    });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.key === 'import')).toMatchObject({
      status: 'done',
    });

    const store = new LoopStore(target);
    const loops = store.listAllLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0].title).toBe('导入的旧循环');
    store.close();
  });

  it('reports an import plan without creating the target database in dry-run', async () => {
    const root = repoFixture('import-dry-run');
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    const source = createLoopDatabase(root, 'old');
    const target = resolveDefaultDbPath({ packageRoot: root, homeDir: home, localAppData });

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      agents: [],
      importDb: source,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.key === 'import')).toMatchObject({
      status: 'planned',
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('marks the import step failed when the source is not an Open Loops database', async () => {
    const root = repoFixture('import-bad');
    const home = path.join(root, 'home');
    const localAppData = path.join(home, 'AppData', 'Local');
    const bad = path.join(root, 'bad.db');
    fs.writeFileSync(bad, 'not sqlite', 'utf8');

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData,
      agents: [],
      importDb: bad,
    });

    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.key === 'import')).toMatchObject({
      status: 'failed',
    });
    expect(result.steps.find((step) => step.key === 'import')?.detail)
      .toContain('not a readable SQLite database');
  });

  it('runs schedule and ingest only when explicitly requested', async () => {
    const root = repoFixture('schedule-ingest');
    const home = path.join(root, 'home');
    let scheduled = 0;
    let ingested = 0;

    const result = await runSetup({
      repoRoot: root,
      homeDir: home,
      localAppData: path.join(home, 'AppData', 'Local'),
      schedule: true,
      ingest: true,
      runSchedule: () => {
        scheduled += 1;
      },
      runIngest: async () => {
        ingested += 1;
      },
    });

    const scheduleStep = result.steps.find((step) => step.key === 'schedule');
    if (process.platform === 'win32') {
      expect(scheduleStep?.status).toBe('done');
      expect(scheduled).toBe(1);
    } else {
      expect(scheduleStep?.status).toBe('skipped');
      expect(scheduled).toBe(0);
    }
    expect(result.steps.find((step) => step.key === 'ingest')?.status).toBe('done');
    expect(ingested).toBe(1);
  });
});
