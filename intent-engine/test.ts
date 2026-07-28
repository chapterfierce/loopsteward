/**
 * Claw Task Service — Intent Engine Tests (Phase 2.5)
 *
 * 20+ test cases covering all 6 intent categories:
 *   create_task / query_status / modify_task / delete_task / schedule / other
 *
 * Run: npx tsx intent-engine/test.ts
 * Target accuracy: ≥ 90% for primary intent classification
 */

import { classify, classifyText } from './classifier.js';
import { IntentResult, TaskIntentCategory } from './types.js';

// ─── Test Case Definitions ──────────────────────────────────────────

interface TestCase {
  id: string;
  message: string;
  expectedPrimary: TaskIntentCategory;
  expectedSub?: string;
  note?: string;
}

const TEST_CASES: TestCase[] = [
  // ═══════════════════════════════════════════════════════════════════
  // 1. create_task (6 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'CT-01',
    message: '创建登录页重构任务',
    expectedPrimary: 'create_task',
    expectedSub: 'general',
    note: 'Explicit task creation with keyword 创建',
  },
  {
    id: 'CT-02',
    message: '帮我在周五前完成支付模块',
    expectedPrimary: 'create_task',
    expectedSub: 'general',
    note: 'Task creation with deadline constraint',
  },
  {
    id: 'CT-03',
    message: '修复那个登录崩溃的bug',
    expectedPrimary: 'create_task',
    expectedSub: 'bugfix',
    note: 'Bug fix task creation',
  },
  {
    id: 'CT-04',
    message: '开发用户头像上传功能',
    expectedPrimary: 'create_task',
    expectedSub: 'feature',
    note: 'Feature development task creation',
  },
  {
    id: 'CT-05',
    message: '写一下API接口文档',
    expectedPrimary: 'create_task',
    expectedSub: 'doc',
    note: 'Documentation task creation',
  },
  {
    id: 'CT-06',
    message: '加一个重构代码的任务',
    expectedPrimary: 'create_task',
    note: 'Implicit task creation through request',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. query_status (5 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'QS-01',
    message: '登录模块怎么样了？',
    expectedPrimary: 'query_status',
    expectedSub: 'single',
    note: 'Single task status query',
  },
  {
    id: 'QS-02',
    message: '我有哪些待办任务？',
    expectedPrimary: 'query_status',
    expectedSub: 'all',
    note: 'Query all pending tasks',
  },
  {
    id: 'QS-03',
    message: 'P0级别有哪些任务？',
    expectedPrimary: 'query_status',
    expectedSub: 'filtered',
    note: 'Filtered query by priority',
  },
  {
    id: 'QS-04',
    message: '本周完成了几个任务？',
    expectedPrimary: 'query_status',
    expectedSub: 'summary',
    note: 'Summary/statistics query',
  },
  {
    id: 'QS-05',
    message: '查看一下订单模块的进度',
    expectedPrimary: 'query_status',
    expectedSub: 'single',
    note: 'View task progress',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 3. modify_task (5 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'MT-01',
    message: '把截止时间改到周五',
    expectedPrimary: 'modify_task',
    expectedSub: 'deadline',
    note: 'Modify deadline',
  },
  {
    id: 'MT-02',
    message: '这个任务优先级提升到P0',
    expectedPrimary: 'modify_task',
    expectedSub: 'priority',
    note: 'Modify priority (upgrade)',
  },
  {
    id: 'MT-03',
    message: '转给张三做',
    expectedPrimary: 'modify_task',
    expectedSub: 'assignee',
    note: 'Reassign task to Zhang San',
  },
  {
    id: 'MT-04',
    message: '标记为已完成',
    expectedPrimary: 'modify_task',
    expectedSub: 'status',
    note: 'Mark task as completed',
  },
  {
    id: 'MT-05',
    message: '补充一下任务的需求描述',
    expectedPrimary: 'modify_task',
    expectedSub: 'description',
    note: 'Update task description',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 4. delete_task (3 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'DT-01',
    message: '取消登录页重构',
    expectedPrimary: 'delete_task',
    expectedSub: 'cancel',
    note: 'Cancel task',
  },
  {
    id: 'DT-02',
    message: '删除那个bug修复任务',
    expectedPrimary: 'delete_task',
    expectedSub: 'single',
    note: 'Delete task explicitly',
  },
  {
    id: 'DT-03',
    message: '归档已完成的迭代任务',
    expectedPrimary: 'delete_task',
    expectedSub: 'archive',
    note: 'Archive completed tasks',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 5. schedule (4 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'SC-01',
    message: '下周有什么安排？',
    expectedPrimary: 'schedule',
    expectedSub: 'view',
    note: 'View week schedule',
  },
  {
    id: 'SC-02',
    message: '周三下午3点安排个评审会',
    expectedPrimary: 'schedule',
    expectedSub: 'create',
    note: 'Create a schedule meeting',
  },
  {
    id: 'SC-03',
    message: '周四下午有空吗？',
    expectedPrimary: 'schedule',
    expectedSub: 'conflict',
    note: 'Check schedule conflict / availability',
  },
  {
    id: 'SC-04',
    message: '把周三的会改到周五',
    expectedPrimary: 'schedule',
    expectedSub: 'modify',
    note: 'Reschedule a meeting',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 6. other / edge cases (3 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'OT-01',
    message: '你好',
    expectedPrimary: 'other',
    note: 'Greeting — should fallback to other',
  },
  {
    id: 'OT-02',
    message: '今天天气怎么样？',
    expectedPrimary: 'other',
    note: 'Unrelated query — should fallback to other',
  },
  {
    id: 'OT-03',
    message: '',
    expectedPrimary: 'other',
    note: 'Empty input — should fallback to other',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 7. debug (5 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'DB-01',
    message: '页面崩溃了，帮忙看下',
    expectedPrimary: 'debug',
    expectedSub: 'crash',
    note: 'Crash debugging',
  },
  {
    id: 'DB-02',
    message: '看下日志，有个报错',
    expectedPrimary: 'debug',
    expectedSub: 'error_log',
    note: 'Error log debugging',
  },
  {
    id: 'DB-03',
    message: '接口响应慢，有性能问题',
    expectedPrimary: 'debug',
    expectedSub: 'performance',
    note: 'Performance debugging',
  },
  {
    id: 'DB-04',
    message: '数据不对，有脏数据',
    expectedPrimary: 'debug',
    expectedSub: 'data_issue',
    note: 'Data issue debugging',
  },
  {
    id: 'DB-05',
    message: '本地跑不起来，环境问题',
    expectedPrimary: 'debug',
    expectedSub: 'environment',
    note: 'Environment debugging',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 8. development (5 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'DV-01',
    message: '实现用户登录功能',
    expectedPrimary: 'development',
    expectedSub: 'feature_impl',
    note: 'Feature implementation',
  },
  {
    id: 'DV-02',
    message: '修复这个bug',
    expectedPrimary: 'development',
    expectedSub: 'bugfix',
    note: 'Bugfix development',
  },
  {
    id: 'DV-03',
    message: '重构这个模块的代码',
    expectedPrimary: 'development',
    expectedSub: 'refactor',
    note: 'Code refactoring',
  },
  {
    id: 'DV-04',
    message: '设计接口定义',
    expectedPrimary: 'development',
    expectedSub: 'api_design',
    note: 'API design',
  },
  {
    id: 'DV-05',
    message: '系统架构方案设计',
    expectedPrimary: 'development',
    expectedSub: 'architecture',
    note: 'Architecture design',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 9. research (4 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'RS-01',
    message: '排查一下这个问题的原因',
    expectedPrimary: 'research',
    expectedSub: 'investigation',
    note: 'Investigation research',
  },
  {
    id: 'RS-02',
    message: '做个POC验证可行性',
    expectedPrimary: 'research',
    expectedSub: 'spike',
    note: 'Spike/POC research',
  },
  {
    id: 'RS-03',
    message: '对比一下两个框架哪个好',
    expectedPrimary: 'research',
    expectedSub: 'comparison',
    note: 'Comparison research',
  },
  {
    id: 'RS-04',
    message: '查阅一下API手册',
    expectedPrimary: 'research',
    expectedSub: 'documentation_lookup',
    note: 'Documentation lookup',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 10. review (4 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'RV-01',
    message: '帮我做个code review',
    expectedPrimary: 'review',
    expectedSub: 'code_review',
    note: 'Code review',
  },
  {
    id: 'RV-02',
    message: '看一下这个PR',
    expectedPrimary: 'review',
    expectedSub: 'pr_review',
    note: 'PR review',
  },
  {
    id: 'RV-03',
    message: '安排个设计评审',
    expectedPrimary: 'review',
    expectedSub: 'design_review',
    note: 'Design review',
  },
  {
    id: 'RV-04',
    message: '测试评审一下用例',
    expectedPrimary: 'review',
    expectedSub: 'test_review',
    note: 'Test review',
  },

  // ═══════════════════════════════════════════════════════════════════
  // 11. planning (4 cases)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'PL-01',
    message: '下个迭代规划排个期',
    expectedPrimary: 'planning',
    expectedSub: 'sprint_planning',
    note: 'Sprint planning',
  },
  {
    id: 'PL-02',
    message: '这个功能估时多少',
    expectedPrimary: 'planning',
    expectedSub: 'estimation',
    note: 'Estimation planning',
  },
  {
    id: 'PL-03',
    message: '规划下版本的roadmap',
    expectedPrimary: 'planning',
    expectedSub: 'roadmap',
    note: 'Roadmap planning',
  },
  {
    id: 'PL-04',
    message: '把需求拆解成子任务',
    expectedPrimary: 'planning',
    expectedSub: 'task_breakdown',
    note: 'Task breakdown',
  },
];

// ─── Test Runner ────────────────────────────────────────────────────

interface TestResult {
  id: string;
  message: string;
  expected: string;
  actual: string;
  subMatch: boolean;
  passed: boolean;
  confidence: number;
  topIntents: string;
  entityCount: number;
  note?: string;
}

function runTests(): TestResult[] {
  const results: TestResult[] = [];

  for (const tc of TEST_CASES) {
    const output = classifyText(tc.message);
    // IntentResult exposes primary category/subCategory directly (no `intents` array).
    const primary = output.category;
    const primarySub = output.subCategory;
    const passed = primary === tc.expectedPrimary;
    const subMatch = !tc.expectedSub || primarySub === tc.expectedSub;

    results.push({
      id: tc.id,
      message: tc.message || '(empty)',
      expected: tc.expectedSub
        ? `${tc.expectedPrimary}.${tc.expectedSub}`
        : tc.expectedPrimary,
      actual: `${primary}.${primarySub}`,
      subMatch,
      passed,
      confidence: output.confidence,
      topIntents: output.alternatives?.slice(0, 2)
        .map(a => `${a.category}.${a.subCategory}(${a.confidence})`)
        .join(', ') ?? '',
      entityCount: output.entities?.length ?? 0,
      note: tc.note,
    });
  }

  return results;
}

// ─── Report Generation ──────────────────────────────────────────────

function printReport(results: TestResult[]): void {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const subPassed = results.filter(r => r.passed && r.subMatch).length;
  const accuracy = ((passed / total) * 100).toFixed(1);
  const subAccuracy = ((subPassed / total) * 100).toFixed(1);

  console.log('='.repeat(80));
  console.log('  Claw Task Service — Intent Engine Test Report (Phase 2.5)');
  console.log('='.repeat(80));
  console.log();

  // Summary
  console.log('  ┌─ Summary ───────────────────────────────────────────────────┐');
  console.log(`  │ Total: ${String(total).padEnd(6)} │ Passed (Category): ${String(passed).padEnd(5)} │ Accuracy: ${accuracy}%       │`);
  console.log(`  │        ${' '.repeat(6)} │ Passed (Category+Sub): ${String(subPassed).padEnd(2)} │ Sub-Acc:  ${subAccuracy}%       │`);
  console.log(`  │ Target: ≥ 90% │ Status: ${parseFloat(accuracy) >= 90 ? '✅ PASS' : '❌ FAIL'}                                       │`);
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log();

  // Per-category breakdown
  const byCategory: Map<string, { total: number; passed: number }> = new Map();
  for (const r of results) {
    const cat = r.expected.split('.')[0];
    const c = byCategory.get(cat) ?? { total: 0, passed: 0 };
    c.total++;
    if (r.passed) c.passed++;
    byCategory.set(cat, c);
  }

  console.log('  ┌─ Category Breakdown ────────────────────────────────────────┐');
  for (const [cat, stats] of byCategory) {
    const catAcc = ((stats.passed / stats.total) * 100).toFixed(1);
    const barLen = Math.round((stats.passed / stats.total) * 20);
    const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
    console.log(`  │ ${cat.padEnd(14)} ${bar} ${String(stats.passed).padStart(2)}/${stats.total} (${catAcc}%) │`);
  }
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log();

  // Failed cases
  const failed = results.filter(r => !r.passed || !r.subMatch);
  if (failed.length > 0) {
    console.log('  ┌─ Failed Cases ──────────────────────────────────────────────┐');
    for (const f of failed) {
      console.log(`  │ [${f.id}] "${f.message.substring(0, 45)}"`);
      const issue = !f.passed ? 'Category mismatch' : 'Sub-category mismatch';
      console.log(`  │       Expected: ${f.expected.padEnd(28)} | Got: ${f.actual.padEnd(28)}`);
      console.log(`  │       Issue: ${issue} | Alt: ${f.topIntents || 'none'}`);
      if (f.note) console.log(`  │       Note: ${f.note}`);
    }
    console.log('  └────────────────────────────────────────────────────────────┘');
    console.log();
  }

  // Detail table
  console.log('  ┌─ All Results ──────────────────────────────────────────────────────────────────┐');
  console.log(`  │ ${'ID'.padEnd(6)} ${'Expected'.padEnd(28)} ${'Actual'.padEnd(28)} ${'Conf'.padEnd(6)} ${'Ent'.padEnd(4)} ${'P/F'.padEnd(4)}│`);
  console.log('  │' + '-'.repeat(81) + '│');
  for (const r of results) {
    const status = r.passed ? '✅' : '❌';
    console.log(`  │ ${r.id.padEnd(6)} ${r.expected.padEnd(28)} ${r.actual.padEnd(28)} ${String(r.confidence).padEnd(6)} ${String(r.entityCount).padEnd(4)} ${status.padEnd(4)}│`);
  }
  console.log('  └─────────────────────────────────────────────────────────────────────────────────┘');
  console.log();

  // Entity extraction stats
  const avgEntities = (results.reduce((sum, r) => sum + r.entityCount, 0) / results.length).toFixed(1);
  const withEntities = results.filter(r => r.entityCount > 0).length;
  console.log(`  Entity Extraction: avg ${avgEntities} entities/case, ${withEntities}/${total} cases with entities`);
  console.log();
  console.log('='.repeat(80));
}

// ─── Quick Smoke Test ───────────────────────────────────────────────

function smokeTest(): boolean {
  console.log('\n  Smoke Test: Running individual classification checks...\n');

  const cases = [
    { text: '创建登录页重构任务', expect: 'create_task', label: 'create_task' },
    { text: '登录模块怎么样了？', expect: 'query_status', label: 'query_status' },
    { text: '把截止时间改到周五', expect: 'modify_task', label: 'modify_task' },
    { text: '取消登录页重构', expect: 'delete_task', label: 'delete_task' },
    { text: '下周有什么安排？', expect: 'schedule', label: 'schedule' },
    { text: '页面崩溃了', expect: 'debug', label: 'debug (crash)' },
    { text: '实现用户登录功能', expect: 'development', label: 'development (feature)' },
    { text: '排查一下原因', expect: 'research', label: 'research (investigation)' },
    { text: '做个code review', expect: 'review', label: 'review (code)' },
    { text: '下个迭代规划', expect: 'planning', label: 'planning (sprint)' },
    { text: '你好', expect: 'other', label: 'other (fallback)' },
  ];

  let allPassed = true;
  for (const tc of cases) {
    const result = classifyText(tc.text);
    const primary = result.category;
    const ok = primary === tc.expect;
    console.log(`  ${ok ? '✅' : '❌'} "${tc.text}" → ${primary} (expected: ${tc.expect})`);
    if (!ok) allPassed = false;
  }

  console.log();
  return allPassed;
}

// ─── Entity Extraction Test ─────────────────────────────────────────

function entityTest(): void {
  console.log('  ┌─ Entity Extraction Examples ───────────────────────────────┐');

  const samples = [
    '把截止时间改到周五下午3点',
    '这个任务优先级提升到P0',
    '转给张三做',
    '标记为已完成',
    '修复那个登录崩溃的bug',
    '周三下午3点安排个评审会',
  ];

  for (const sample of samples) {
    const result = classifyText(sample);
    const entityInfo = result.entities
      .map(e => `${e.type}:${e.value}(${e.confidence})`)
      .join(', ') || 'none';
    console.log(`  │ "${sample}"`);
    console.log(`  │   Entities: ${entityInfo}`);
  }

  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log();
}

// ─── Main ───────────────────────────────────────────────────────────

console.clear();
console.log();
console.log('  ╔══════════════════════════════════════════════════════════════════════╗');
console.log('  ║     Claw Task Service — Intent Engine Phase 2.5 Test Suite          ║');
console.log('  ╚══════════════════════════════════════════════════════════════════════╝');

// Run smoke test first
const smokeOk = smokeTest();

// Run full test suite
const results = runTests();
printReport(results);

// Entity extraction examples
entityTest();

// Exit code for CI
const failedCount = results.filter(r => !r.passed).length;
if (failedCount > 0) {
  console.log(`\n  ❌ ${failedCount} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\n  ✅ All tests passed!');
}
