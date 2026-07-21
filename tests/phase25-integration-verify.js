/**
 * Phase 2.5 Integration Verification Test
 *
 * Validates that the intent-engine pipeline correctly classifies
 * messages across all 11 intent categories (including the 5 new
 * development-oriented categories: debug, development, research,
 * review, planning).
 *
 * Run: npx tsx tests/phase25-integration-verify.js
 *
 * Target: ≥ 60% E2E accuracy (up from 46.2% baseline)
 */

import { classifyIntent, classifyAndRoute } from '../intent-engine/pipeline.js';
import { getRuleStats } from '../intent-engine/patterns.js';
import { debugClassify } from '../intent-engine/classifier.js';

// ─── Test Cases ─────────────────────────────────────────────────────

const E2E_TEST_CASES = [
  // Task management (original Phase 2.5)
  { id: 'E2E-001', text: '创建一个用户注册的重构任务', expect: 'create_task', note: 'Explicit creation' },
  { id: 'E2E-002', text: '帮我在周五前完成支付模块', expect: 'create_task', note: 'Creation with deadline' },
  { id: 'E2E-003', text: '修复登录崩溃的bug', expect: 'create_task', note: 'Bugfix task creation' },
  { id: 'E2E-004', text: '开发用户头像上传功能', expect: 'create_task', note: 'Feature task creation' },
  { id: 'E2E-005', text: '写一下API接口文档', expect: 'create_task', note: 'Doc task creation' },
  
  { id: 'E2E-006', text: '登录模块怎么样了？', expect: 'query_status', note: 'Single status query' },
  { id: 'E2E-007', text: '我有哪些待办任务？', expect: 'query_status', note: 'List all tasks' },
  { id: 'E2E-008', text: 'P0级别有哪些任务？', expect: 'query_status', note: 'Filtered query' },
  { id: 'E2E-009', text: '本周完成了几个任务？', expect: 'query_status', note: 'Summary query' },
  { id: 'E2E-010', text: '查看订单模块进度', expect: 'query_status', note: 'View progress' },
  
  { id: 'E2E-011', text: '把截止时间改到周五', expect: 'modify_task', note: 'Modify deadline' },
  { id: 'E2E-012', text: '优先级提升到P0', expect: 'modify_task', note: 'Modify priority' },
  { id: 'E2E-013', text: '转给张三做', expect: 'modify_task', note: 'Reassign' },
  { id: 'E2E-014', text: '标记为已完成', expect: 'modify_task', note: 'Mark complete' },
  
  { id: 'E2E-015', text: '删除那个bug修复任务', expect: 'delete_task', note: 'Delete task' },
  { id: 'E2E-016', text: '取消登录页重构', expect: 'delete_task', note: 'Cancel task' },
  { id: 'E2E-017', text: '归档已完成的任务', expect: 'delete_task', note: 'Archive' },
  
  { id: 'E2E-018', text: '下周有什么安排？', expect: 'schedule', note: 'View schedule' },
  { id: 'E2E-019', text: '周三下午3点安排个评审会', expect: 'schedule', note: 'Create schedule' },
  { id: 'E2E-020', text: '周四下午有空吗？', expect: 'schedule', note: 'Conflict check' },
  { id: 'E2E-021', text: '把周三的会改到周五', expect: 'schedule', note: 'Reschedule' },

  // Debug (new)
  { id: 'E2E-022', text: '页面崩溃了帮忙看下', expect: 'debug', note: 'Crash debug' },
  { id: 'E2E-023', text: '看下日志有个报错', expect: 'debug', note: 'Error log debug' },
  { id: 'E2E-024', text: '接口响应慢有性能问题', expect: 'debug', note: 'Performance debug' },
  { id: 'E2E-025', text: '数据不对有脏数据', expect: 'debug', note: 'Data issue debug' },
  { id: 'E2E-026', text: '本地跑不起来环境问题', expect: 'debug', note: 'Environment debug' },

  // Development (new)
  { id: 'E2E-027', text: '实现用户登录功能', expect: 'development', note: 'Feature impl' },
  { id: 'E2E-028', text: '重构这个模块的代码', expect: 'development', note: 'Refactor' },
  { id: 'E2E-029', text: '设计接口定义', expect: 'development', note: 'API design' },
  { id: 'E2E-030', text: '系统架构方案设计', expect: 'development', note: 'Architecture' },

  // Research (new)
  { id: 'E2E-031', text: '排查一下这个问题的原因', expect: 'research', note: 'Investigation' },
  { id: 'E2E-032', text: '做个POC验证可行性', expect: 'research', note: 'Spike/POC' },
  { id: 'E2E-033', text: '对比一下两个框架哪个好', expect: 'research', note: 'Comparison' },
  { id: 'E2E-034', text: '查阅一下API手册', expect: 'research', note: 'Docs lookup' },

  // Review (new)
  { id: 'E2E-035', text: '帮我做个code review', expect: 'review', note: 'Code review' },
  { id: 'E2E-036', text: '看一下这个PR', expect: 'review', note: 'PR review' },
  { id: 'E2E-037', text: '安排个设计评审', expect: 'review', note: 'Design review' },

  // Planning (new)
  { id: 'E2E-038', text: '下个迭代规划排个期', expect: 'planning', note: 'Sprint planning' },
  { id: 'E2E-039', text: '这个功能估时多少', expect: 'planning', note: 'Estimation' },
  { id: 'E2E-040', text: '规划下版本的roadmap', expect: 'planning', note: 'Roadmap' },
  { id: 'E2E-041', text: '把需求拆解成子任务', expect: 'planning', note: 'Task breakdown' },

  // Edge cases
  { id: 'E2E-042', text: '你好', expect: 'other', note: 'Greeting fallback' },
  { id: 'E2E-043', text: '今天天气怎么样？', expect: 'other', note: 'Unrelated fallback' },
];

// ─── Runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedCases = [];
const results = [];

console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════╗');
console.log('  ║  Phase 2.5 Intent Engine — E2E Integration Verification               ║');
console.log('  ╚══════════════════════════════════════════════════════════════════════╝');
console.log('');

// Print rule stats
const stats = getRuleStats();
console.log(`  Rule Library: ${stats.totalRules} rules, ${stats.totalTriggerWords} triggers, ${stats.categories.length} categories`);
console.log(`  Categories: ${stats.categories.join(', ')}`);
console.log('');

console.log('  ┌─ Test Results ──────────────────────────────────────────────────────────┐');
console.log(`  │ ${'ID'.padEnd(10)} ${'Expected'.padEnd(16)} ${'Actual'.padEnd(16)} ${'Conf'.padEnd(6)} ${'Route'.padEnd(16)} ${'P/F'.padEnd(4)}│`);
console.log('  │' + '─'.repeat(81) + '│');

for (const tc of E2E_TEST_CASES) {
  const result = classifyIntent(tc.text);
  const actualCategory = result.category;
  const isPass = actualCategory === tc.expect;
  const confidence = result.confidence.toFixed(2);
  const route = result.routeHandler;

  if (isPass) {
    passed++;
  } else {
    failed++;
    failedCases.push({
      id: tc.id,
      text: tc.text,
      expected: tc.expect,
      actual: actualCategory,
      confidence: result.confidence,
      alternatives: result.alternatives?.map(a => `${a.category}(${a.confidence.toFixed(2)})`).join(', ') || 'none',
      note: tc.note,
    });
  }

  results.push({
    id: tc.id,
    expected: tc.expect,
    actual: actualCategory,
    confidence: result.confidence,
    route,
    passed: isPass,
  });

  const status = isPass ? '✅' : '❌';
  console.log(`  │ ${tc.id.padEnd(10)} ${tc.expect.padEnd(16)} ${actualCategory.padEnd(16)} ${confidence.padEnd(6)} ${route.padEnd(16)} ${status.padEnd(4)}│`);
}

console.log('  └' + '─'.repeat(83) + '┘');
console.log('');

// ─── Summary ────────────────────────────────────────────────────────

const total = E2E_TEST_CASES.length;
const accuracy = ((passed / total) * 100).toFixed(1);
const target = 60.0;
const targetMet = parseFloat(accuracy) >= target;

console.log('  ┌─ Summary ───────────────────────────────────────────────────────────────┐');
console.log(`  │ Total: ${total}  │  Passed: ${passed}  │  Failed: ${failed}  │  Accuracy: ${accuracy}%         │`);
console.log(`  │ Target: ≥ ${target}%  │  Status: ${targetMet ? '✅ PASS' : '❌ FAIL'}                                            │`);
console.log('  └──────────────────────────────────────────────────────────────────────────┘');
console.log('');

// ─── Category Breakdown ─────────────────────────────────────────────

const byCategory = {};
for (const r of results) {
  if (!byCategory[r.expected]) byCategory[r.expected] = { total: 0, passed: 0 };
  byCategory[r.expected].total++;
  if (r.passed) byCategory[r.expected].passed++;
}

console.log('  ┌─ Category Breakdown ────────────────────────────────────────────────────┐');
for (const [cat, s] of Object.entries(byCategory)) {
  const acc = ((s.passed / s.total) * 100).toFixed(1);
  const barLen = Math.round((s.passed / s.total) * 20);
  const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
  console.log(`  │ ${cat.padEnd(16)} ${bar} ${String(s.passed).padStart(2)}/${s.total} (${acc}%)`);
}
console.log('  └──────────────────────────────────────────────────────────────────────────┘');
console.log('');

// ─── Failed Cases Detail ────────────────────────────────────────────

if (failedCases.length > 0) {
  console.log('  ┌─ Failed Cases Detail ────────────────────────────────────────────────────┐');
  for (const f of failedCases) {
    console.log(`  │ [${f.id}] "${f.text}"`);
    console.log(`  │       Expected: ${f.expected.padEnd(14)} → Actual: ${f.actual.padEnd(14)}`);
    console.log(`  │       Conf: ${f.confidence.toFixed(2)}  │  Alt: ${f.alternatives}`);
    console.log(`  │       Note: ${f.note}`);
  }
  console.log('  └──────────────────────────────────────────────────────────────────────────┘');
  console.log('');
}

// ─── Pipeline Stats ─────────────────────────────────────────────────

const avgConf = results.reduce((s, r) => s + r.confidence, 0) / results.length;
const avgConfStr = avgConf.toFixed(3);
console.log(`  Average Confidence: ${avgConfStr}`);
console.log(`  Pipeline Version: 2.5.0`);
console.log('');

// ─── Exit ───────────────────────────────────────────────────────────

if (targetMet) {
  console.log(`  ✅ E2E accuracy ${accuracy}% ≥ ${target}% target — PASS`);
} else {
  console.log(`  ❌ E2E accuracy ${accuracy}% < ${target}% target — FAIL`);
}

process.exitCode = targetMet ? 0 : 1;
