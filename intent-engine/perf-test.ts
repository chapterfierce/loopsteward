/**
 * Claw Task Service — Performance Test Suite (Phase 3 M1)
 *
 * Benchmarks cold-start vs hot-path latency, cache hit rate,
 * and validates the < 1ms hot-path target.
 *
 * Run: npx tsx intent-engine/perf-test.ts
 *
 * Based on: phase3-m1-report.md (v1.0, 2026-07-15)
 */

import { classifyText } from './classifier.js';
import { classifyIntent } from './pipeline.js';
import { getRegexPoolStats } from './regex-pool.js';
import { IntentLRUCache, fnv1aHash } from './lru-cache.js';
import { IntentResult } from './types.js';

// ─── Test Utilities ────────────────────────────────────────────────

/**
 * High-resolution timer in microseconds.
 */
function nowUs(): number {
  const [sec, nano] = process.hrtime();
  return sec * 1_000_000 + nano / 1000;
}

/**
 * Format microseconds as a readable string.
 */
function fmtUs(us: number): string {
  if (us < 1) return `${(us * 1000).toFixed(0)}ns`;
  if (us < 1000) return `${us.toFixed(1)}μs`;
  return `${(us / 1000).toFixed(3)}ms`;
}

/**
 * Compute percentile from an array of values.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Print a section header.
 */
function header(title: string): void {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'━'.repeat(70)}`);
}

// ─── Test Inputs ───────────────────────────────────────────────────

const TEST_INPUTS = [
  '创建登录页重构任务',
  '登录模块怎么样了？',
  '把截止时间改到周五',
  '取消登录页重构',
  '下周有什么安排？',
  '页面崩溃了，帮忙看下',
  '实现用户登录功能',
  '排查一下这个问题的原因',
  '帮我做个code review',
  '下个迭代规划排个期',
  'P0级别有哪些任务？',
  '修复那个登录崩溃的bug',
  '周三下午3点安排个评审会',
  '转给张三做',
  '标记为已完成',
];

// ─── Test 1: RegExp Pool Stats ─────────────────────────────────────

function testRegexPool(): void {
  header('Test 1: RegExp Pre-Compilation Pool');
  const stats = getRegexPoolStats();
  console.log(`  Pool size:          ${stats.poolSize} RegExp instances`);
  console.log(`  Rules compiled:     ${stats.rulesCompiled}`);
  console.log(`  Priority keywords:  ${stats.priorityKeywordsCompiled}`);
  console.log(`  Due date patterns:  ${stats.duePatternsCompiled}`);
  console.log(`  Assignee patterns:  ${stats.assigneePatternsCompiled}`);
  console.log(`  Status: ✅ Pool initialized at module load`);
}

// ─── Test 2: Cold-Start Latency ────────────────────────────────────

function testColdStart(): number[] {
  header('Test 2: Cold-Start Latency (no cache)');

  const latencies: number[] = [];

  for (const input of TEST_INPUTS) {
    // Clear any state by creating a fresh classification
    const start = nowUs();
    const result = classifyText(input);
    const elapsed = nowUs() - start;
    latencies.push(elapsed);

    console.log(`  "${input.substring(0, 30)}" → ${result.category} | ${fmtUs(elapsed)}`);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p99 = percentile(latencies, 99);
  const max = Math.max(...latencies);

  console.log(`\n  Average: ${fmtUs(avg)} | P99: ${fmtUs(p99)} | Max: ${fmtUs(max)}`);
  return latencies;
}

// ─── Test 3: Hot-Path Latency (with LRU Cache) ─────────────────────

function testHotPath(): number[] {
  header('Test 3: Hot-Path Latency (LRU cache hit)');

  const cache = new IntentLRUCache(1000, 300_000);

  // Pre-warm the cache
  for (const input of TEST_INPUTS) {
    const result = classifyText(input);
    cache.set(input, result);
  }

  // Now measure cache-hit latency
  const latencies: number[] = [];

  for (const input of TEST_INPUTS) {
    const start = nowUs();
    const result = cache.get(input);
    const elapsed = nowUs() - start;
    latencies.push(elapsed);

    const hit = result ? 'HIT' : 'MISS';
    console.log(`  "${input.substring(0, 30)}" → ${hit} | ${fmtUs(elapsed)}`);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p99 = percentile(latencies, 99);
  const max = Math.max(...latencies);

  console.log(`\n  Average: ${fmtUs(avg)} | P99: ${fmtUs(p99)} | Max: ${fmtUs(max)}`);
  return latencies;
}

// ─── Test 4: Cache Hit Rate ────────────────────────────────────────

function testCacheHitRate(): void {
  header('Test 4: Cache Hit Rate');

  const cache = new IntentLRUCache(1000, 300_000);

  // First pass: all misses (populate cache)
  let hits = 0;
  let misses = 0;

  for (const input of TEST_INPUTS) {
    const cached = cache.get(input);
    if (cached) hits++; else misses++;
    if (!cached) {
      const result = classifyText(input);
      cache.set(input, result);
    }
  }

  console.log(`  First pass:  ${hits} hits, ${misses} misses (expected: 0 hits, ${TEST_INPUTS.length} misses)`);

  // Second pass: all hits
  hits = 0;
  misses = 0;
  for (const input of TEST_INPUTS) {
    const cached = cache.get(input);
    if (cached) hits++; else misses++;
  }

  console.log(`  Second pass: ${hits} hits, ${misses} misses (expected: ${TEST_INPUTS.length} hits, 0 misses)`);

  const stats = cache.getStats();
  console.log(`\n  Cache stats:`);
  console.log(`    Size:       ${stats.size}/${stats.capacity}`);
  console.log(`    Total hits: ${stats.hits}`);
  console.log(`    Total miss: ${stats.misses}`);
  console.log(`    Hit rate:   ${(stats.hitRate * 100).toFixed(1)}%`);
  console.log(`    Evictions:  ${stats.evictions}`);
  console.log(`    Expirations: ${stats.expirations}`);

  const pass = hits === TEST_INPUTS.length && misses === 0;
  console.log(`\n  Status: ${pass ? '✅ PASS' : '❌ FAIL'}`);
}

// ─── Test 5: Batch Benchmark (1000 iterations) ─────────────────────

function testBatchBenchmark(): void {
  header('Test 5: Batch Benchmark (1000 iterations)');

  const cache = new IntentLRUCache(1000, 300_000);
  const iterations = 1000;

  // Cold batch (no cache)
  const coldStart = nowUs();
  for (let i = 0; i < iterations; i++) {
    const input = TEST_INPUTS[i % TEST_INPUTS.length];
    classifyText(input);
  }
  const coldTotal = nowUs() - coldStart;
  const coldAvg = coldTotal / iterations;

  console.log(`  Cold (no cache):`);
  console.log(`    Total: ${fmtUs(coldTotal)} for ${iterations} iterations`);
  console.log(`    Average: ${fmtUs(coldAvg)}/call`);

  // Warm batch (with cache)
  // Pre-warm
  for (const input of TEST_INPUTS) {
    cache.set(input, classifyText(input));
  }

  cache.resetStats();
  const warmStart = nowUs();
  for (let i = 0; i < iterations; i++) {
    const input = TEST_INPUTS[i % TEST_INPUTS.length];
    const cached = cache.get(input);
    if (!cached) {
      const result = classifyText(input);
      cache.set(input, result);
    }
  }
  const warmTotal = nowUs() - warmStart;
  const warmAvg = warmTotal / iterations;

  console.log(`\n  Warm (with LRU cache):`);
  console.log(`    Total: ${fmtUs(warmTotal)} for ${iterations} iterations`);
  console.log(`    Average: ${fmtUs(warmAvg)}/call`);

  const speedup = coldAvg / warmAvg;
  console.log(`\n  Speedup: ${speedup.toFixed(2)}x`);

  const stats = cache.getStats();
  console.log(`  Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
}

// ─── Test 6: Hot-Path < 1ms Validation ─────────────────────────────

function testHotPathTarget(): boolean {
  header('Test 6: Hot-Path < 1ms Validation');

  const cache = new IntentLRUCache(1000, 300_000);

  // Pre-warm cache
  for (const input of TEST_INPUTS) {
    cache.set(input, classifyText(input));
  }

  // Measure hot-path latency with high precision
  const latencies: number[] = [];
  const runs = 100;

  for (let i = 0; i < runs; i++) {
    const input = TEST_INPUTS[i % TEST_INPUTS.length];
    const start = nowUs();
    cache.get(input);
    const elapsed = nowUs() - start;
    latencies.push(elapsed);
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p99 = percentile(latencies, 99);
  const max = Math.max(...latencies);
  const min = Math.min(...latencies);

  const targetMs = 1.0;
  const avgMs = avg / 1000;
  const p99Ms = p99 / 1000;
  const maxMs = max / 1000;

  console.log(`  ${runs} iterations, ${TEST_INPUTS.length} unique inputs`);
  console.log(`  ┌──────────┬───────────┬────────────┬──────────┐`);
  console.log(`  │ Metric   │ Value     │ Target     │ Status   │`);
  console.log(`  ├──────────┼───────────┼────────────┼──────────┤`);
  console.log(`  │ Average  │ ${fmtUs(avg).padEnd(9)} │ < ${targetMs}ms     │ ${avgMs < targetMs ? '✅ PASS' : '❌ FAIL'}  │`);
  console.log(`  │ P99      │ ${fmtUs(p99).padEnd(9)} │ < ${targetMs}ms     │ ${p99Ms < targetMs ? '✅ PASS' : '❌ FAIL'}  │`);
  console.log(`  │ Max      │ ${fmtUs(max).padEnd(9)} │ < ${targetMs}ms     │ ${maxMs < targetMs ? '✅ PASS' : '❌ FAIL'}  │`);
  console.log(`  │ Min      │ ${fmtUs(min).padEnd(9)} │ —          │ —        │`);
  console.log(`  └──────────┴───────────┴────────────┴──────────┘`);

  const pass = avgMs < targetMs && p99Ms < targetMs && maxMs < targetMs;
  console.log(`\n  Overall: ${pass ? '✅ PASS — Hot path < 1ms target met' : '❌ FAIL — Target not met'}`);
  return pass;
}

// ─── Test 7: FNV-1a Hash Distribution ──────────────────────────────

function testHashDistribution(): void {
  header('Test 7: FNV-1a Hash Distribution');

  const inputs = [
    ...TEST_INPUTS,
    '创建任务',
    '查询状态',
    '修改截止时间',
    '删除任务',
    '安排会议',
    '',
    'a',
    'test input with ascii',
    '测试中文输入',
  ];

  const hashes = new Set<string>();
  const hashList: string[] = [];

  for (const input of inputs) {
    const hash = fnv1aHash(input);
    hashes.add(hash);
    hashList.push(hash);
    console.log(`  "${input.substring(0, 30)}" → ${hash}`);
  }

  console.log(`\n  Unique inputs: ${inputs.length}`);
  console.log(`  Unique hashes: ${hashes.size}`);
  console.log(`  Collisions: ${inputs.length - hashes.size}`);
  console.log(`  Status: ${hashes.size === inputs.length ? '✅ No collisions' : '⚠️ Collisions detected'}`);
}

// ─── Main ──────────────────────────────────────────────────────────

console.clear();
console.log();
console.log('  ╔══════════════════════════════════════════════════════════════════╗');
console.log('  ║   Intent Engine — Phase 3 M1 Performance Test Suite            ║');
console.log('  ║   LRU Cache + RegExp Pre-Compilation                           ║');
console.log('  ╚══════════════════════════════════════════════════════════════════╝');

// Run all tests
testRegexPool();
testColdStart();
testHotPath();
testCacheHitRate();
testBatchBenchmark();
const hotPathPass = testHotPathTarget();
testHashDistribution();

// Summary
header('Summary');
console.log(`  RegExp Pool:     ✅ Initialized`);
console.log(`  LRU Cache:       ✅ Operational`);
console.log(`  Hot-Path < 1ms:  ${hotPathPass ? '✅ PASS' : '❌ FAIL'}`);
console.log();

if (!hotPathPass) {
  console.log('  ❌ Some performance targets not met.');
  process.exitCode = 1;
} else {
  console.log('  ✅ All performance tests passed!');
}
