/**
 * Claw Task Service — Phase 3 M4 Integration Tests
 *
 * Covers the intent-engine → Task Manager integration layer:
 *   Part 1: Unit — transition path finding, normalizers, title derivation
 *   Part 2: Unit — TaskStore fuzzy lookup + TaskManager lifecycle guards
 *   Part 3: E2E  — user utterance → classifyIntent → bridge → task CRUD
 *   Part 4: Confidence gating (confirm_with_user / offer_alternatives / fallback)
 *   Part 5: Lifecycle audit trail (auto-advance transitions are logged)
 *
 * Run: npx tsx tests/m4-integration-test.ts
 */

import {
  IntentTaskBridge,
  deriveTitle,
  normalizePriority,
  normalizeStatus,
  subCategoryToTaskCategory,
  pickEntity,
} from '../src/task-manager/intent-task-bridge.js';
import { TaskManager, findTransitionPath } from '../src/task-manager/task-manager.js';
import { TaskStore, longestCommonSubstring } from '../src/task-manager/task-store.js';
import { PipelineResult } from '../intent-engine/pipeline.js';
import { TaskEntity } from '../intent-engine/types.js';

// ─── Test Harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`✅ PASS — ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` [${detail}]` : ''));
    console.log(`❌ FAIL — ${name}${detail ? ` [${detail}]` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 50 - title.length))}`);
}

// ─── Part 1: Unit — path finding / normalizers / title ─────────────

section('Part 1: Transition paths & normalizers');

{
  check('path created→completed = assigned,in_progress,completed',
    JSON.stringify(findTransitionPath('created', 'completed'))
      === JSON.stringify(['assigned', 'in_progress', 'completed']));
  check('path created→cancelled = cancelled (direct)',
    JSON.stringify(findTransitionPath('created', 'cancelled'))
      === JSON.stringify(['cancelled']));
  check('path in_progress→on_hold = on_hold',
    JSON.stringify(findTransitionPath('in_progress', 'on_hold'))
      === JSON.stringify(['on_hold']));
  check('path completed→in_progress unreachable',
    findTransitionPath('completed', 'in_progress') === undefined);
  check('path cancelled→completed unreachable',
    findTransitionPath('cancelled', 'completed') === undefined);
  check('path same-state = empty',
    findTransitionPath('created', 'created')?.length === 0);

  check('normalizePriority p0 → P0', normalizePriority('p0') === 'P0');
  check('normalizePriority P3 → P3', normalizePriority('P3') === 'P3');
  check('normalizePriority 紧急 → P0', normalizePriority('紧急') === 'P0');
  check('normalizePriority 低 → P3', normalizePriority('低') === 'P3');
  check('normalizePriority garbage → undefined', normalizePriority('xyz') === undefined);

  check('normalizeStatus 已完成 → completed', normalizeStatus('已完成') === 'completed');
  check('normalizeStatus 进行中 → in_progress', normalizeStatus('进行中') === 'in_progress');
  check('normalizeStatus 暂停 → on_hold', normalizeStatus('暂停') === 'on_hold');
  check('normalizeStatus 取消 → cancelled', normalizeStatus('取消') === 'cancelled');
  check('normalizeStatus garbage → undefined', normalizeStatus('xyz') === undefined);

  check('subCategory bugfix → bugfix', subCategoryToTaskCategory('bugfix') === 'bugfix');
  check('subCategory single → general', subCategoryToTaskCategory('single') === 'general');

  const ents: TaskEntity[] = [
    { type: 'task_name', value: '创建登录', position: 0, confidence: 0.75 },
    { type: 'priority', value: 'p0', position: 10, confidence: 0.95 },
  ];
  check('deriveTitle strips trigger verb', deriveTitle('创建登录页面任务', ents) === '登录');
  check('pickEntity picks highest confidence',
    pickEntity(ents, 'priority')?.value === 'p0');
  check('longestCommonSubstring basic', longestCommonSubstring('登录页面', '把登录任务') === 2);
}

// ─── Part 2: Unit — store fuzzy lookup + lifecycle guards ──────────

section('Part 2: TaskStore & TaskManager guards');

{
  const mgr = new TaskManager();
  const created = mgr.createTask({ title: '重构用户模块', priority: 'P1' });
  check('createTask ok', created.ok && created.task !== undefined);
  const id = created.task!.id;

  check('findByReference fuzzy hit',
    mgr.findTaskByReference('那个重构用户的任务')?.id === id);
  check('findByReference no-overlap miss',
    mgr.findTaskByReference('xyz') === undefined);

  // Lifecycle: auto-advance created → completed
  const done = mgr.changeStatus(id, 'completed');
  check('auto-advance created→completed ok', done.ok && done.task?.status === 'completed');

  // Guard: completed is terminal
  const revive = mgr.changeStatus(id, 'in_progress');
  check('completed→in_progress rejected', !revive.ok);
  check('rejection message mentions 非法状态流转', revive.message.includes('非法状态流转'));
  check('rejected op does not mutate task', mgr.getTask(id)?.status === 'completed');

  // Guard: cancel a completed task
  const cancel = mgr.cancelTask(id);
  check('cancel completed task rejected', !cancel.ok);

  // Modify assignee on a fresh created task auto-assigns
  const t2 = mgr.createTask({ title: '编写API文档' }).task!;
  const mod = mgr.modifyTask(t2.id, { assignee: '李四' });
  check('modify assignee ok', mod.ok && mod.task?.assignee === '李四');
  check('assignee set moves created→assigned', mod.task?.status === 'assigned');

  // Archive excludes from fuzzy lookup
  mgr.archiveTask(t2.id);
  check('archived task excluded from reference lookup',
    mgr.findTaskByReference('API文档') === undefined);
}

// ─── Part 3: E2E — utterance → intent → task operation ─────────────

section('Part 3: E2E intent → task CRUD');

{
  const bridge = new IntentTaskBridge(new TaskManager());

  // 3.1 create with priority
  const r1 = bridge.handleUserInput('创建登录页面开发任务，优先级P0，负责人张三');
  check('e2e create: executed', r1.executed && r1.operation === 'create');
  check('e2e create: route task.create', r1.routeHandler === 'task.create');
  check('e2e create: success + task', r1.result?.success === true && !!r1.result?.task);
  check('e2e create: priority P0', r1.result?.task?.priority === 'P0');
  check('e2e create: title contains 登录', (r1.result?.task?.title ?? '').includes('登录'));

  // 3.2 create bugfix with deadline
  const r2 = bridge.handleUserInput('新建一个修复支付崩溃的任务，周五截止');
  check('e2e create#2: executed', r2.executed && r2.operation === 'create');
  check('e2e create#2: category bugfix', r2.result?.task?.category === 'bugfix');
  check('e2e create#2: deadline 周五', r2.result?.task?.deadline === '周五');
  check('e2e create#2: title contains 支付', (r2.result?.task?.title ?? '').includes('支付'));

  // 3.3 query all
  const r3 = bridge.handleUserInput('查看我的所有任务');
  check('e2e query all: executed', r3.executed && r3.operation === 'query');
  check('e2e query all: 2 tasks', r3.result?.tasks?.length === 2);

  // 3.4 query single by fuzzy reference
  const r4 = bridge.handleUserInput('登录页面那个任务进度怎么样了');
  check('e2e query single: executed', r4.executed && r4.operation === 'query');
  check('e2e query single: found login task',
    (r4.result?.task?.title ?? '').includes('登录'));
  check('e2e query single: intentCategory recorded',
    r4.result?.intentCategory === 'query_status');

  // 3.5 modify priority
  const r5 = bridge.handleUserInput('把登录页面任务的优先级改成P1');
  check('e2e modify priority: executed', r5.executed && r5.operation === 'modify');
  check('e2e modify priority: P1', r5.result?.task?.priority === 'P1');

  // 3.6 modify status → completed (auto-advance through lifecycle)
  const r6 = bridge.handleUserInput('把登录页面任务标记为已完成');
  check('e2e modify status: executed', r6.executed && r6.operation === 'modify');
  check('e2e modify status: completed', r6.result?.task?.status === 'completed');

  // 3.7 delete (cancel) via lifecycle
  const r7 = bridge.handleUserInput('取消支付那个任务');
  check('e2e cancel: executed', r7.executed && r7.operation === 'delete');
  check('e2e cancel: status cancelled', r7.result?.task?.status === 'cancelled');

  // 3.8 delete (archive)
  const r8 = bridge.handleUserInput('归档登录页面任务');
  check('e2e archive: executed', r8.executed && r8.operation === 'delete');
  check('e2e archive: archived flag', r8.result?.task?.archived === true);

  // 3.9 archived + cancelled tasks drop out of default query
  const r9 = bridge.handleUserInput('查看我的所有任务');
  check('e2e query after archive: 1 task left (cancelled, non-archived)',
    r9.result?.tasks?.length === 1);

  // 3.10 non-task intent is routed, not executed
  const r10 = bridge.handleUserInput('实现用户认证接口');
  check('e2e dev intent: not executed', !r10.executed && r10.operation === 'none');
  check('e2e dev intent: routed to dev.execute', r10.routeHandler === 'dev.execute');

  // 3.11 unintelligible input → no execution
  const r11 = bridge.handleUserInput('呃呃呃呃呃');
  check('e2e gibberish: not executed', !r11.executed);
  check('e2e gibberish: no task op result', r11.result === undefined);

  // 3.12 modify with no matching task fails gracefully
  const fresh = new IntentTaskBridge(new TaskManager());
  const r12 = fresh.handleUserInput('把登录页面任务的优先级改成P1');
  check('e2e modify on empty store: executed but not successful',
    r12.executed && r12.result?.success === false);
  check('e2e modify on empty store: message mentions 未找到',
    (r12.result?.message ?? '').includes('未找到'));
}

// ─── Part 4: Confidence gating ─────────────────────────────────────

section('Part 4: Confidence gating');

function makeIntent(overrides: Partial<PipelineResult>): PipelineResult {
  return {
    category: 'create_task',
    subCategory: 'general',
    confidence: 0.9,
    entities: [],
    alternatives: [],
    rationale: 'synthetic',
    ambiguous: false,
    meta: {
      processingTimeMs: 0,
      inputLength: 0,
      rulesEvaluated: 0,
      rulesMatched: 0,
      disambiguationTriggered: false,
      contextUsed: false,
      source: 'rule_engine',
    },
    recommendedAction: 'execute_directly',
    routeHandler: 'task.create',
    contextInfluenced: false,
    pipelineVersion: '3.0.0',
    cacheHit: false,
    llmFallbackUsed: false,
    ...overrides,
  };
}

{
  const bridge = new IntentTaskBridge(new TaskManager());

  // confirm_with_user without autoConfirm → held for confirmation
  const held = bridge.handleIntent(
    makeIntent({ confidence: 0.6, recommendedAction: 'confirm_with_user' }),
    '创建一个测试任务',
  );
  check('gating: confirm_with_user not executed', !held.executed);
  check('gating: needsConfirmation flag set', held.needsConfirmation === true);
  check('gating: no task created while held', bridge.manager.queryTasks().total === 0);

  // confirm_with_user with autoConfirm=true → executes
  const auto = new IntentTaskBridge(new TaskManager(), { autoConfirm: true });
  const ok = auto.handleIntent(
    makeIntent({ confidence: 0.6, recommendedAction: 'confirm_with_user' }),
    '创建一个测试任务',
  );
  check('gating: autoConfirm executes', ok.executed && ok.result?.success === true);

  // offer_alternatives → never executes
  const alt = bridge.handleIntent(
    makeIntent({ confidence: 0.35, recommendedAction: 'offer_alternatives' }),
    '创建一个测试任务',
  );
  check('gating: offer_alternatives not executed', !alt.executed && !alt.needsConfirmation);

  // fallback_help → never executes
  const fb = bridge.handleIntent(
    makeIntent({ confidence: 0.1, recommendedAction: 'fallback_help' }),
    '创建一个测试任务',
  );
  check('gating: fallback_help not executed', !fb.executed);
}

// ─── Part 5: Lifecycle audit trail ─────────────────────────────────

section('Part 5: Lifecycle audit trail');

{
  const mgr = new TaskManager();
  const bridge = new IntentTaskBridge(mgr);
  const created = bridge.handleUserInput('创建数据迁移任务');
  const taskId = created.result?.task?.id ?? '';
  check('audit: task created', created.executed && taskId !== '');

  bridge.handleUserInput('把数据迁移任务标记为已完成');
  const events = mgr.getLifecycleEvents(taskId);
  check('audit: 3 transitions logged for created→completed', events.length === 3,
    `got ${events.length}`);
  check('audit: transition chain correct',
    JSON.stringify(events.map(e => e.to))
      === JSON.stringify(['assigned', 'in_progress', 'completed']));
  check('audit: task ends completed', mgr.getTask(taskId)?.status === 'completed');
}

// ─── Summary ───────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`  M4 Integration Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(60));
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log('\n✅ All M4 integration tests passed!');
}
