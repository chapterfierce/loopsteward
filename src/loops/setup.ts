import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildLoopDoctor, type LoopDoctorReport } from './doctor.js';
import { findPackageRoot } from './package-root.js';
import { resolveDefaultDbPath } from './data-path.js';
import { restoreLoopDatabase } from './restore.js';
import {
  installOpenLoopsSkillForAgents,
  skillAgentTargets,
  type SkillAgent,
} from './skill-install.js';
import {
  installSessionPolicy,
  policyTargets,
  type PolicyAgent,
} from './session-policy.js';

const DEFAULT_SETUP_AGENTS: SkillAgent[] = ['hermes'];

export interface SetupOptions {
  repoRoot?: string;
  homeDir?: string;
  localAppData?: string;
  agents?: SkillAgent[];
  dryRun?: boolean;
  schedule?: boolean;
  ingest?: boolean;
  importDb?: string;
  now?: Date;
  runBuild?: (root: string) => void;
  runSchedule?: (root: string) => void;
  runIngest?: (root: string) => Promise<void>;
}

export type SetupStepStatus = 'done' | 'skipped' | 'planned' | 'failed';

export interface SetupStep {
  key: string;
  status: SetupStepStatus;
  detail: string;
}

export interface SetupResult {
  ok: boolean;
  steps: SetupStep[];
  doctor?: LoopDoctorReport;
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function compiledCliPath(root: string): string {
  return path.join(root, 'dist', 'src', 'loops', 'cli.js');
}

function defaultBuild(root: string): void {
  execFileSync(npmCommand(), ['run', 'build:open-loops'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
}

function defaultSchedule(root: string): void {
  const script = path.join(root, 'scripts', 'install-refresh-task.ps1');
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
}

async function defaultIngest(root: string): Promise<void> {
  execFileSync(
    process.execPath,
    [compiledCliPath(root), 'ingest', '--days', '7', '--limit', '120', '--concurrency', '4'],
    { cwd: root, stdio: 'inherit', windowsHide: true },
  );
}

function skipped(key: string, detail: string): SetupStep {
  return { key, status: 'skipped', detail };
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const root = path.resolve(options.repoRoot ?? findPackageRoot());
  const home = options.homeDir;
  const localAppData = options.localAppData;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const steps: SetupStep[] = [];

  const cliPath = compiledCliPath(root);
  if (fs.existsSync(cliPath)) {
    steps.push(skipped('build', `已存在 ${cliPath}`));
  } else if (dryRun) {
    steps.push({ key: 'build', status: 'planned', detail: 'npm run build:open-loops' });
  } else {
    try {
      (options.runBuild ?? defaultBuild)(root);
      steps.push({ key: 'build', status: 'done', detail: 'npm run build:open-loops' });
    } catch (error) {
      steps.push({ key: 'build', status: 'failed', detail: (error as Error).message });
    }
  }

  const targetDbPath = resolveDefaultDbPath({
    packageRoot: root,
    homeDir: home,
    localAppData,
  });
  if (!options.importDb) {
    steps.push(skipped('import', '未指定 --import-db'));
  } else {
    try {
      const imported = restoreLoopDatabase({
        backupPath: options.importDb,
        dbPath: targetDbPath,
        dryRun,
      });
      steps.push({
        key: 'import',
        status: dryRun ? 'planned' : 'done',
        detail: dryRun
          ? `将导入 ${imported.loops} loops / ${imported.signals} signals 到 ${imported.target}`
          : `已导入 ${imported.loops} loops / ${imported.signals} signals 到 ${imported.target}`,
      });
    } catch (error) {
      steps.push({ key: 'import', status: 'failed', detail: (error as Error).message });
    }
  }

  const requestedAgents = options.agents ?? DEFAULT_SETUP_AGENTS;
  const skillTargets = skillAgentTargets({ homeDir: home, localAppData })
    .filter((target) => fs.existsSync(target.root));
  const requestedSkillAgents = requestedAgents.filter(
    (agent) => skillTargets.some((target) => target.agent === agent),
  );
  const selectedSkills = skillTargets.filter(
    (target) => requestedSkillAgents.includes(target.agent),
  );
  if (selectedSkills.length === 0) {
    steps.push(
      requestedAgents.length > 0
        ? {
            key: 'skill',
            status: 'failed',
            detail: `未检测到可安装 skill 的 Agent：${requestedAgents.join(', ')}；先启动一次对应 Agent，确认目录存在后重试`,
          }
        : skipped('skill', '未选择 Agent'),
    );
  } else if (dryRun) {
    steps.push({
      key: 'skill',
      status: 'planned',
      detail: `安装到 ${selectedSkills.map((target) => target.agent).join(', ')}`,
    });
  } else {
    try {
      const results = installOpenLoopsSkillForAgents({
        homeDir: home,
        localAppData,
        agents: requestedSkillAgents,
        sourcePath: path.join(root, 'skills', 'open-loops', 'SKILL.md'),
        packageRoot: root,
        now,
      });
      steps.push({
        key: 'skill',
        status: 'done',
        detail: results.map((result) => `${result.agent}:${result.action}`).join(', '),
      });
    } catch (error) {
      steps.push({ key: 'skill', status: 'failed', detail: (error as Error).message });
    }
  }

  const policyTargetsAll = policyTargets({ homeDir: home, localAppData });
  const requestedPolicyAgents = requestedAgents
    .filter((agent) => policyTargetsAll.some((target) => target.agent === agent)) as PolicyAgent[];
  const policyCandidates = policyTargetsAll.filter(
    (target) =>
      requestedPolicyAgents.includes(target.agent)
      && (fs.existsSync(target.root) || fs.existsSync(target.file)),
  );
  if (policyCandidates.length === 0) {
    steps.push(
      requestedAgents.length > 0
        ? {
            key: 'policy',
            status: 'failed',
            detail: `未检测到可写入的 Agent 入口文件：${requestedAgents.join(', ')}；先启动一次对应 Agent，确认目录存在后重试`,
          }
        : skipped('policy', '未选择 Agent'),
    );
  } else if (dryRun) {
    steps.push({
      key: 'policy',
      status: 'planned',
      detail: `写入 ${policyCandidates.map((target) => target.agent).join(', ')}`,
    });
  } else {
    try {
      const results = installSessionPolicy({
        homeDir: home,
        localAppData,
        agents: requestedPolicyAgents,
        scriptPath: path.join(root, 'scripts', 'open-loops.ps1'),
        now,
      });
      steps.push({
        key: 'policy',
        status: 'done',
        detail: results.map((result) => `${result.agent}:${result.action}`).join(', '),
      });
    } catch (error) {
      steps.push({ key: 'policy', status: 'failed', detail: (error as Error).message });
    }
  }

  if (!options.schedule) {
    steps.push(skipped('schedule', '未指定 --schedule'));
  } else if (process.platform !== 'win32') {
    steps.push(skipped('schedule', '非 Windows 平台'));
  } else if (dryRun) {
    steps.push({ key: 'schedule', status: 'planned', detail: '注册 OpenLoopsRefresh' });
  } else {
    try {
      (options.runSchedule ?? defaultSchedule)(root);
      steps.push({ key: 'schedule', status: 'done', detail: 'OpenLoopsRefresh 已注册' });
    } catch (error) {
      steps.push({ key: 'schedule', status: 'failed', detail: (error as Error).message });
    }
  }

  if (!options.ingest) {
    steps.push(skipped('ingest', '未指定 --ingest'));
  } else if (dryRun) {
    steps.push({ key: 'ingest', status: 'planned', detail: '首次摄入最近 7 天会话' });
  } else {
    try {
      await (options.runIngest ?? defaultIngest)(root);
      steps.push({ key: 'ingest', status: 'done', detail: '最近 7 天会话已摄入' });
    } catch (error) {
      steps.push({ key: 'ingest', status: 'failed', detail: (error as Error).message });
    }
  }

  if (dryRun) {
    return { ok: !steps.some((step) => step.status === 'failed'), steps };
  }

  const doctor = buildLoopDoctor({
    packageRoot: root,
    dbPath: targetDbPath,
    allowMissingDatabase: true,
    home,
    localAppData,
    scheduledTask: options.schedule === true,
    skillAgents: requestedSkillAgents,
    policyAgents: requestedPolicyAgents,
  });
  return {
    ok: !steps.some((step) => step.status === 'failed') && doctor.ok,
    steps,
    doctor,
  };
}

export function formatSetup(result: SetupResult): string {
  const lines = ['# Open Loops setup', ''];
  for (const step of result.steps) {
    const mark = step.status === 'done'
      ? 'DONE'
      : step.status === 'skipped'
        ? 'SKIP'
        : step.status === 'planned'
          ? 'PLAN'
          : 'FAIL';
    lines.push(`- [${mark}] ${step.key}: ${step.detail}`);
  }
  if (result.doctor) {
    lines.push('', `健康检查：${result.doctor.ok ? '没有阻塞性问题' : '存在阻塞性问题'}；${result.doctor.warnings.length} 项需要关注。`);
  }
  const failedSteps = result.steps.some((step) => step.status === 'failed');
  lines.push(
    '',
    result.ok
      ? '结论：初始化完成。'
      : failedSteps
        ? '结论：有步骤失败，见上方 FAIL。'
        : '结论：健康检查未通过，见上方检查结果。',
  );
  return lines.join('\n');
}
