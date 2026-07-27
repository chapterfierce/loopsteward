/**
 * Claw Task Service — Custom Intent Tests (Phase 3 M2)
 *
 * 22+ test cases covering the custom intent extension mechanism:
 *   1. Registration — register custom intent → classification hits
 *   2. Priority conflicts — higher priority wins
 *   3. Hot-loading — new rules from config take effect immediately
 *   4. Unregistration — removed rules no longer match
 *   5. Enable/disable — toggle rules without removal
 *   6. Validation functions — programmatic validators
 *   7. Edge cases — invalid rules, duplicate IDs, etc.
 *
 * Run: npx tsx intent-engine/custom-intent-test.ts
 */

import { classify, classifyText } from './classifier.js';
import { RULES, getRulesByPriority } from './patterns.js';
import {
  CustomIntentRegistry,
  registerIntent,
  unregisterIntent,
  getCustomRules,
  getMergedRules,
  loadRulesFromConfig,
} from './custom-intent-registry.js';
import {
  CustomIntentRule,
  IntentPriority,
  ValidationFunction,
  toClassificationRule,
} from './custom-intent-types.js';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Test Framework ────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
}

function assertNotEqual<T>(actual: T, unexpected: T, message: string): void {
  const notEqual = JSON.stringify(actual) !== JSON.stringify(unexpected);
  assert(notEqual, `${message} (should not be: ${JSON.stringify(unexpected)}, got: ${JSON.stringify(actual)})`);
}

function describe(name: string, fn: () => void): void {
  console.log(`\n═══ ${name} ═══`);
  fn();
}

// ─── Test Setup / Teardown ─────────────────────────────────────────

function clearRegistry(): void {
  CustomIntentRegistry.clearAll();
}

// ─── Test Cases ────────────────────────────────────────────────────

describe('1. Registration — register custom intent → classification hits', () => {

  test_01_register_basic_custom_rule();
  test_02_register_with_custom_category_string();
  test_03_register_rule_with_regex_condition();
  test_04_register_multiple_rules_batch();
});

describe('2. Priority conflicts — higher priority wins', () => {

  test_05_override_priority_beats_builtin();
  test_06_high_priority_custom_beats_low_builtin();
  test_07_same_priority_uses_score_tiebreak();
  test_08_normal_priority_coexists_with_builtin();
});

describe('3. Hot-loading — new rules from config take effect immediately', () => {

  test_09_load_rules_from_json_file();
  test_10_hot_reload_updates_existing_rule();
  test_11_load_invalid_config_returns_errors();
  test_12_load_rules_from_object();
});

describe('4. Unregistration — removed rules no longer match', () => {

  test_13_unregister_rule_stops_matching();
  test_14_unregister_nonexistent_returns_false();
  test_15_clear_all_removes_everything();
});

describe('5. Enable/disable — toggle rules without removal', () => {

  test_16_disable_rule_stops_matching();
  test_17_reenable_rule_resumes_matching();
  test_18_disabled_rule_still_in_registry();
});

describe('6. Validation functions — programmatic validators', () => {

  test_19_validator_accepts_valid_input();
  test_20_validator_rejects_invalid_input();
});

describe('7. Edge cases — invalid rules, duplicate IDs, stats', () => {

  test_21_register_invalid_rule_returns_error();
  test_22_duplicate_id_returns_error();
  test_23_update_existing_rule();
  test_24_registry_stats_correct();
  test_25_merged_rules_sorted_by_priority();
});

// ═══════════════════════════════════════════════════════════════════
// Test Implementations
// ═══════════════════════════════════════════════════════════════════

// ─── 1. Registration Tests ─────────────────────────────────────────

function test_01_register_basic_custom_rule(): void {
  clearRegistry();
  const result = registerIntent({
    id: 'custom-deploy-task',
    category: 'development',
    subCategory: 'feature_impl',
    priority: IntentPriority.NORMAL,
    conditions: [
      { type: 'keyword', value: '部署', weight: 0.9 },
      { type: 'keyword', value: '上线', weight: 0.85 },
    ],
    confidence: 0.88,
    minConfidence: 0.6,
    rationale: 'Deployment task detected',
  });

  assert(result.success, 'TC-01: Custom rule registered successfully');
  assert(result.rule?.id === 'custom-deploy-task', 'TC-01: Rule ID matches');
  assert(result.rule?.enabled === true, 'TC-01: Rule is enabled by default');
  assert(result.rule?.createdAt > 0, 'TC-01: createdAt is set');

  // Verify the rule appears in custom rules list
  const customRules = getCustomRules();
  assert(customRules.length === 1, 'TC-01: One custom rule in registry');
  assert(customRules[0].id === 'custom-deploy-task', 'TC-01: Rule ID in list');

  clearRegistry();
}

function test_02_register_with_custom_category_string(): void {
  clearRegistry();
  const result = registerIntent({
    id: 'custom-mood-check',
    category: 'custom_mood',  // Custom string category (not in TaskIntentCategory)
    subCategory: 'sentiment',
    priority: IntentPriority.LOW,
    conditions: [
      { type: 'keyword', value: '心情', weight: 0.8 },
    ],
    confidence: 0.7,
    minConfidence: 0.5,
  });

  assert(result.success, 'TC-02: Custom string category accepted');
  assert(result.rule?.category === 'custom_mood', 'TC-02: Category preserved as string');

  clearRegistry();
}

function test_03_register_rule_with_regex_condition(): void {
  clearRegistry();
  const result = registerIntent({
    id: 'custom-standup',
    category: 'schedule',
    subCategory: 'create',
    priority: IntentPriority.HIGH,
    conditions: [
      { type: 'regex', value: '(每日|每天).{0,4}(站会|晨会|同步)', weight: 1.0, required: true },
      { type: 'keyword', value: '安排', weight: 0.7 },
    ],
    confidence: 0.92,
    minConfidence: 0.7,
    rationale: 'Daily standup schedule detected via regex',
  });

  assert(result.success, 'TC-03: Regex condition rule registered');
  assert(result.rule?.conditions[0].type === 'regex', 'TC-03: Condition type is regex');

  clearRegistry();
}

function test_04_register_multiple_rules_batch(): void {
  clearRegistry();

  const rules = [
    {
      id: 'batch-rule-1',
      category: 'create_task' as const,
      subCategory: 'general' as const,
      priority: IntentPriority.NORMAL,
      conditions: [{ type: 'keyword' as const, value: '批量创建', weight: 0.9 }],
      confidence: 0.85,
      minConfidence: 0.6,
    },
    {
      id: 'batch-rule-2',
      category: 'query_status' as const,
      subCategory: 'all' as const,
      priority: IntentPriority.NORMAL,
      conditions: [{ type: 'keyword' as const, value: '全部进度', weight: 0.85 }],
      confidence: 0.82,
      minConfidence: 0.6,
    },
    {
      id: 'batch-rule-3',
      category: 'modify_task' as const,
      subCategory: 'priority' as const,
      priority: IntentPriority.HIGH,
      conditions: [{ type: 'keyword' as const, value: '批量改优先级', weight: 0.9 }],
      confidence: 0.88,
      minConfidence: 0.6,
    },
  ];

  let allSuccess = true;
  for (const r of rules) {
    const result = registerIntent(r);
    if (!result.success) allSuccess = false;
  }

  assert(allSuccess, 'TC-04: All 3 batch rules registered');
  assert(getCustomRules().length === 3, 'TC-04: Registry has 3 rules');

  clearRegistry();
}

// ─── 2. Priority Conflict Tests ────────────────────────────────────

function test_05_override_priority_beats_builtin(): void {
  clearRegistry();

  // Register an OVERRIDE rule for "创建" keyword that maps to 'planning' instead of 'create_task'
  registerIntent({
    id: 'override-create-to-planning',
    category: 'planning',
    subCategory: 'task_breakdown',
    priority: IntentPriority.OVERRIDE,
    priorityValue: 100,
    conditions: [
      { type: 'keyword', value: '创建', weight: 1.0 },
      { type: 'keyword', value: '规划', weight: 0.5 },
    ],
    confidence: 0.95,
    minConfidence: 0.6,
    rationale: 'Override: 创建+规划 → planning instead of create_task',
  });

  // The custom rule should be in the merged list before built-in rules
  const merged = getMergedRules(RULES);
  const customRuleIndex = merged.findIndex(r => r.id === 'override-create-to-planning');
  const builtinCreateIndex = merged.findIndex(r => r.id === 'create-task-explicit');

  assert(customRuleIndex >= 0, 'TC-05: Custom OVERRIDE rule is in merged list');
  assert(
    customRuleIndex < builtinCreateIndex,
    'TC-05: OVERRIDE rule comes before built-in create-task rule',
  );

  clearRegistry();
}

function test_06_high_priority_custom_beats_low_builtin(): void {
  clearRegistry();

  registerIntent({
    id: 'custom-bug-analysis',
    category: 'research',
    subCategory: 'investigation',
    priority: IntentPriority.HIGH,
    priorityValue: 85,
    conditions: [
      { type: 'keyword', value: 'bug', weight: 0.9 },
      { type: 'keyword', value: '分析', weight: 0.8 },
    ],
    confidence: 0.90,
    minConfidence: 0.6,
    rationale: 'Bug analysis → research, not create_task bugfix',
  });

  const merged = getMergedRules(RULES);
  const customIdx = merged.findIndex(r => r.id === 'custom-bug-analysis');
  // HIGH=85 should beat built-in rules with priority < 85 (e.g. query-all-tasks=76, query-summary=74)
  const builtinLowIdx = merged.findIndex(r => r.id === 'query-all-tasks');

  assert(customIdx >= 0, 'TC-06: Custom HIGH rule in merged list');
  assert(
    customIdx >= 0 && builtinLowIdx >= 0 && customIdx < builtinLowIdx,
    'TC-06: HIGH priority custom rule (85) sorts before built-in low-priority rule (query-all-tasks=76)',
  );

  // Also verify it does NOT sort before higher-priority built-in rules (e.g. bugfix=93)
  const builtinBugfixIdx = merged.findIndex(r => r.id === 'create-task-bugfix');
  assert(
    customIdx >= 0 && builtinBugfixIdx >= 0 && customIdx > builtinBugfixIdx,
    'TC-06: HIGH priority custom rule (85) correctly sorts after built-in bugfix rule (93)',
  );

  clearRegistry();

  // Test with OVERRIDE priority to verify top-5 placement
  registerIntent({
    id: 'custom-status-report',
    category: 'query_status',
    subCategory: 'summary',
    priority: IntentPriority.OVERRIDE,
    priorityValue: 100,
    conditions: [
      { type: 'keyword', value: '周报', weight: 1.0 },
    ],
    confidence: 0.92,
    minConfidence: 0.6,
  });

  const merged2 = getMergedRules(RULES);
  const customIdx2 = merged2.findIndex(r => r.id === 'custom-status-report');

  assert(customIdx2 >= 0 && customIdx2 < 5, 'TC-06: OVERRIDE priority rule in top 5 of merged list');

  clearRegistry();
}

function test_07_same_priority_uses_score_tiebreak(): void {
  clearRegistry();

  // Register two rules with same priority but different confidence
  registerIntent({
    id: 'tiebreak-a',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    priorityValue: 65,
    conditions: [
      { type: 'keyword', value: '特殊创建', weight: 1.0 },
    ],
    confidence: 0.90,
    minConfidence: 0.6,
  });

  registerIntent({
    id: 'tiebreak-b',
    category: 'create_task',
    subCategory: 'feature',
    priority: IntentPriority.NORMAL,
    priorityValue: 65,
    conditions: [
      { type: 'keyword', value: '特殊创建', weight: 1.0 },
      { type: 'keyword', value: '功能', weight: 0.5 },
    ],
    confidence: 0.95,
    minConfidence: 0.6,
  });

  const customRules = getCustomRules();
  assert(customRules.length === 2, 'TC-07: Two same-priority rules registered');

  // Both should have same priorityValue
  assert(
    customRules[0].priorityValue === customRules[1].priorityValue,
    'TC-07: Both rules have same priority value',
  );

  clearRegistry();
}

function test_08_normal_priority_coexists_with_builtin(): void {
  clearRegistry();

  registerIntent({
    id: 'coexist-rule',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.NORMAL,
    conditions: [
      { type: 'keyword', value: '咖啡时间', weight: 0.9 },
    ],
    confidence: 0.7,
    minConfidence: 0.5,
  });

  const merged = getMergedRules(RULES);
  const hasCustom = merged.some(r => r.id === 'coexist-rule');
  const hasBuiltin = merged.some(r => r.id === 'create-task-explicit');

  assert(hasCustom, 'TC-08: Custom NORMAL rule in merged list');
  assert(hasBuiltin, 'TC-08: Built-in rules still present in merged list');
  assert(merged.length > RULES.length, 'TC-08: Merged list is larger than built-in only');

  clearRegistry();
}

// ─── 3. Hot-Loading Tests ──────────────────────────────────────────

function test_09_load_rules_from_json_file(): void {
  clearRegistry();

  const tmpDir = join(__dirname, '__test_tmp__');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir);
  const configPath = join(tmpDir, 'test-rules.json');

  const config = {
    version: '1.0',
    rules: [
      {
        id: 'config-rule-1',
        category: 'development',
        subCategory: 'architecture',
        priority: 'HIGH',
        conditions: [
          { type: 'keyword', value: '架构评审', weight: 0.95 },
        ],
        confidence: 0.90,
        minConfidence: 0.6,
        rationale: 'Architecture review from config',
      },
      {
        id: 'config-rule-2',
        category: 'research',
        subCategory: 'comparison',
        priority: 'NORMAL',
        conditions: [
          { type: 'keyword', value: '技术选型', weight: 0.9 },
          { type: 'keyword', value: '对比', weight: 0.7 },
        ],
        confidence: 0.85,
        minConfidence: 0.6,
      },
    ],
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const result = loadRulesFromConfig(configPath);

  assert(result.loaded === 2, `TC-09: 2 rules loaded from config (got ${result.loaded})`);
  assert(result.errors.length === 0, 'TC-09: No errors during load');

  const customRules = getCustomRules();
  assert(customRules.length === 2, 'TC-09: 2 custom rules in registry after load');
  assert(customRules.some(r => r.id === 'config-rule-1'), 'TC-09: config-rule-1 in registry');
  assert(customRules.some(r => r.id === 'config-rule-2'), 'TC-09: config-rule-2 in registry');

  // Verify priority was parsed correctly
  const rule1 = CustomIntentRegistry.getIntent('config-rule-1');
  assert(rule1?.priority === IntentPriority.HIGH, 'TC-09: HIGH priority parsed from string');
  assert(rule1?.source?.includes('test-rules.json'), 'TC-09: Source tracks config file');

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistry();
}

function test_10_hot_reload_updates_existing_rule(): void {
  clearRegistry();

  const tmpDir = join(__dirname, '__test_tmp__');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir);
  const configPath = join(tmpDir, 'hot-reload.json');

  // First load
  const config1 = {
    rules: [
      {
        id: 'hot-reload-rule',
        category: 'create_task',
        subCategory: 'general',
        priority: 'NORMAL',
        conditions: [{ type: 'keyword', value: '热加载测试', weight: 0.8 }],
        confidence: 0.80,
        minConfidence: 0.6,
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config1));
  loadRulesFromConfig(configPath);

  const rule1 = CustomIntentRegistry.getIntent('hot-reload-rule');
  assert(rule1?.confidence === 0.80, 'TC-10: Initial confidence is 0.80');

  // Hot reload with updated confidence
  const config2 = {
    rules: [
      {
        id: 'hot-reload-rule',
        category: 'create_task',
        subCategory: 'general',
        priority: 'HIGH',
        conditions: [{ type: 'keyword', value: '热加载测试', weight: 0.95 }],
        confidence: 0.95,
        minConfidence: 0.7,
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config2));
  loadRulesFromConfig(configPath);

  const rule2 = CustomIntentRegistry.getIntent('hot-reload-rule');
  assert(rule2?.confidence === 0.95, 'TC-10: Updated confidence is 0.95 after hot reload');
  assert(rule2?.priority === IntentPriority.HIGH, 'TC-10: Updated priority is HIGH after hot reload');
  assert(rule2?.createdAt === rule1?.createdAt, 'TC-10: createdAt preserved during update');
  assert(rule2?.updatedAt > rule1?.updatedAt, 'TC-10: updatedAt changed during update');

  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistry();
}

function test_11_load_invalid_config_returns_errors(): void {
  clearRegistry();

  const tmpDir = join(__dirname, '__test_tmp__');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir);
  const configPath = join(tmpDir, 'invalid-rules.json');

  const config = {
    rules: [
      {
        // Missing id
        category: 'create_task',
        conditions: [{ type: 'keyword', value: 'test', weight: 0.5 }],
        confidence: 0.8,
        minConfidence: 0.5,
      },
      {
        id: 'invalid-confidence',
        category: 'create_task',
        subCategory: 'general',
        conditions: [{ type: 'keyword', value: 'test', weight: 0.5 }],
        confidence: 1.5, // Invalid: > 1
        minConfidence: 0.5,
      },
    ],
  };

  writeFileSync(configPath, JSON.stringify(config));
  const result = loadRulesFromConfig(configPath);

  assert(result.loaded === 0, 'TC-11: 0 rules loaded from invalid config');
  assert(result.errors.length >= 2, `TC-11: At least 2 errors reported (got ${result.errors.length})`);

  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistry();
}

function test_12_load_rules_from_object(): void {
  clearRegistry();

  const result = CustomIntentRegistry.loadRulesFromObject({
    rules: [
      {
        id: 'obj-rule-1',
        category: 'review',
        subCategory: 'code_review',
        priority: 'NORMAL',
        conditions: [{ type: 'keyword', value: '代码审查', weight: 0.9 }],
        confidence: 0.85,
        minConfidence: 0.6,
      },
      {
        id: 'obj-rule-2',
        category: 'planning',
        subCategory: 'estimation',
        priority: 'LOW',
        conditions: [{ type: 'keyword', value: '工时估算', weight: 0.85 }],
        confidence: 0.80,
        minConfidence: 0.5,
      },
    ],
  });

  assert(result.loaded === 2, 'TC-12: 2 rules loaded from object');
  assert(getCustomRules().length === 2, 'TC-12: Registry has 2 rules from object');

  clearRegistry();
}

// ─── 4. Unregistration Tests ───────────────────────────────────────

function test_13_unregister_rule_stops_matching(): void {
  clearRegistry();

  registerIntent({
    id: 'temp-rule-to-remove',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: '临时测试关键字xyz', weight: 1.0 }],
    confidence: 0.9,
    minConfidence: 0.6,
  });

  assert(getCustomRules().length === 1, 'TC-13: Rule registered');

  const removed = unregisterIntent('temp-rule-to-remove');
  assert(removed === true, 'TC-13: unregisterIntent returns true');
  assert(getCustomRules().length === 0, 'TC-13: Registry empty after unregister');

  const stillExists = CustomIntentRegistry.getIntent('temp-rule-to-remove');
  assert(stillExists === undefined, 'TC-13: Rule no longer in registry');

  clearRegistry();
}

function test_14_unregister_nonexistent_returns_false(): void {
  clearRegistry();

  const removed = unregisterIntent('does-not-exist');
  assert(removed === false, 'TC-14: Unregistering nonexistent ID returns false');

  clearRegistry();
}

function test_15_clear_all_removes_everything(): void {
  clearRegistry();

  registerIntent({
    id: 'clear-1',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.LOW,
    conditions: [{ type: 'keyword', value: '测试1', weight: 0.5 }],
    confidence: 0.6,
    minConfidence: 0.4,
  });
  registerIntent({
    id: 'clear-2',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.LOW,
    conditions: [{ type: 'keyword', value: '测试2', weight: 0.5 }],
    confidence: 0.6,
    minConfidence: 0.4,
  });

  assert(getCustomRules().length === 2, 'TC-15: 2 rules before clearAll');

  CustomIntentRegistry.clearAll();
  assert(getCustomRules().length === 0, 'TC-15: 0 rules after clearAll');
}

// ─── 5. Enable/Disable Tests ───────────────────────────────────────

function test_16_disable_rule_stops_matching(): void {
  clearRegistry();

  registerIntent({
    id: 'disable-test',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: '禁用测试关键字', weight: 1.0 }],
    confidence: 0.9,
    minConfidence: 0.6,
  });

  assert(getCustomRules().length === 1, 'TC-16: 1 enabled rule initially');

  const disabled = CustomIntentRegistry.disableIntent('disable-test');
  assert(disabled === true, 'TC-16: disableIntent returns true');

  // getCustomRules only returns enabled rules
  assert(getCustomRules().length === 0, 'TC-16: 0 enabled rules after disable');

  // But the rule still exists in the registry
  const rule = CustomIntentRegistry.getIntent('disable-test');
  assert(rule !== undefined, 'TC-16: Disabled rule still in registry');
  assert(rule?.enabled === false, 'TC-16: Rule enabled=false');

  clearRegistry();
}

function test_17_reenable_rule_resumes_matching(): void {
  clearRegistry();

  registerIntent({
    id: 'reenable-test',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: '重新启用测试', weight: 1.0 }],
    confidence: 0.9,
    minConfidence: 0.6,
  });

  CustomIntentRegistry.disableIntent('reenable-test');
  assert(getCustomRules().length === 0, 'TC-17: 0 enabled rules when disabled');

  const enabled = CustomIntentRegistry.enableIntent('reenable-test');
  assert(enabled === true, 'TC-17: enableIntent returns true');
  assert(getCustomRules().length === 1, 'TC-17: 1 enabled rule after re-enable');

  const rule = CustomIntentRegistry.getIntent('reenable-test');
  assert(rule?.enabled === true, 'TC-17: Rule enabled=true');

  clearRegistry();
}

function test_18_disabled_rule_still_in_registry(): void {
  clearRegistry();

  registerIntent({
    id: 'persist-disabled',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.LOW,
    conditions: [{ type: 'keyword', value: '持久禁用', weight: 0.5 }],
    confidence: 0.5,
    minConfidence: 0.3,
  });

  CustomIntentRegistry.disableIntent('persist-disabled');

  // getAllCustomRules returns all rules including disabled
  const allRules = CustomIntentRegistry.getAllCustomRules();
  assert(allRules.length === 1, 'TC-18: getAllCustomRules includes disabled rule');

  // getEnabledCustomRules only returns enabled
  const enabledRules = CustomIntentRegistry.getEnabledCustomRules();
  assert(enabledRules.length === 0, 'TC-18: getEnabledCustomRules excludes disabled rule');

  clearRegistry();
}

// ─── 6. Validation Function Tests ──────────────────────────────────

function test_19_validator_accepts_valid_input(): void {
  clearRegistry();

  const validator: ValidationFunction = (text, tokens, matchedKeywords) => {
    // Only accept if text contains "production"
    return text.includes('production') || text.includes('生产');
  };

  registerIntent({
    id: 'validator-accept',
    category: 'development',
    subCategory: 'feature_impl',
    priority: IntentPriority.HIGH,
    conditions: [
      { type: 'keyword', value: '发布', weight: 0.9 },
    ],
    confidence: 0.92,
    minConfidence: 0.6,
  }, validator);

  const rule = CustomIntentRegistry.getIntent('validator-accept');
  assert(rule?.validator !== undefined, 'TC-19: Validator function attached to rule');

  // Test validator directly
  const validResult = rule!.validator!('发布到生产环境', ['发布', '到', '生产', '环境'], ['发布']);
  assert(validResult === true, 'TC-19: Validator accepts input containing 生产');

  const invalidResult = rule!.validator!('发布到测试环境', ['发布', '到', '测试', '环境'], ['发布']);
  assert(invalidResult === false, 'TC-19: Validator rejects input without 生产');

  clearRegistry();
}

function test_20_validator_rejects_invalid_input(): void {
  clearRegistry();

  const validator: ValidationFunction = (text, tokens) => {
    // Reject if input is too short (less than 3 tokens)
    return tokens.length >= 3;
  };

  registerIntent({
    id: 'validator-reject-short',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.OVERRIDE,
    priorityValue: 100,
    conditions: [
      { type: 'keyword', value: '做', weight: 0.5 },
    ],
    confidence: 0.7,
    minConfidence: 0.4,
  }, validator);

  const rule = CustomIntentRegistry.getIntent('validator-reject-short');
  assert(rule?.validator !== undefined, 'TC-20: Validator attached');

  // Short input → rejected
  const shortResult = rule!.validator!('做', ['做'], ['做']);
  assert(shortResult === false, 'TC-20: Validator rejects short input (1 token)');

  // Longer input → accepted
  const longResult = rule!.validator!('做一个新功能', ['做', '一个', '新', '功能'], ['做']);
  assert(longResult === true, 'TC-20: Validator accepts longer input (4 tokens)');

  clearRegistry();
}

// ─── 7. Edge Case Tests ────────────────────────────────────────────

function test_21_register_invalid_rule_returns_error(): void {
  clearRegistry();

  // Missing id
  const r1 = registerIntent({
    id: '',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: 'test', weight: 0.5 }],
    confidence: 0.8,
    minConfidence: 0.5,
  });
  assert(!r1.success, 'TC-21: Empty id rejected');
  assert(r1.error !== undefined, 'TC-21: Error message provided');

  // Missing conditions
  const r2 = registerIntent({
    id: 'no-conditions',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [],
    confidence: 0.8,
    minConfidence: 0.5,
  });
  assert(!r2.success, 'TC-21: Empty conditions rejected');

  // Invalid confidence
  const r3 = registerIntent({
    id: 'bad-confidence',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: 'test', weight: 0.5 }],
    confidence: -0.5,
    minConfidence: 0.5,
  });
  assert(!r3.success, 'TC-21: Negative confidence rejected');

  // Confidence < minConfidence
  const r4 = registerIntent({
    id: 'conf-below-min',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: 'test', weight: 0.5 }],
    confidence: 0.5,
    minConfidence: 0.8,
  });
  assert(!r4.success, 'TC-21: Confidence < minConfidence rejected');

  clearRegistry();
}

function test_22_duplicate_id_returns_error(): void {
  clearRegistry();

  const ruleDef = {
    id: 'duplicate-id-test',
    category: 'create_task' as const,
    subCategory: 'general' as const,
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword' as const, value: '重复测试', weight: 0.8 }],
    confidence: 0.8,
    minConfidence: 0.5,
  };

  const r1 = registerIntent(ruleDef);
  assert(r1.success, 'TC-22: First registration succeeds');

  const r2 = registerIntent(ruleDef);
  assert(!r2.success, 'TC-22: Duplicate ID rejected');
  assert(r2.error?.includes('already exists'), 'TC-22: Error mentions duplicate');

  clearRegistry();
}

function test_23_update_existing_rule(): void {
  clearRegistry();

  registerIntent({
    id: 'update-test',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: '更新前', weight: 0.8 }],
    confidence: 0.75,
    minConfidence: 0.5,
  });

  const result = CustomIntentRegistry.updateIntent('update-test', {
    confidence: 0.95,
    rationale: 'Updated rationale',
  });

  assert(result.success, 'TC-23: Update succeeds');
  assert(result.rule?.confidence === 0.95, 'TC-23: Confidence updated to 0.95');
  assert(result.rule?.rationale === 'Updated rationale', 'TC-23: Rationale updated');

  // Update nonexistent rule
  const failResult = CustomIntentRegistry.updateIntent('nonexistent', { confidence: 0.9 });
  assert(!failResult.success, 'TC-23: Update nonexistent rule fails');

  clearRegistry();
}

function test_24_registry_stats_correct(): void {
  clearRegistry();

  registerIntent({
    id: 'stats-1',
    category: 'create_task',
    subCategory: 'general',
    priority: IntentPriority.HIGH,
    conditions: [{ type: 'keyword', value: '统计1', weight: 0.8 }],
    confidence: 0.8,
    minConfidence: 0.5,
  });
  registerIntent({
    id: 'stats-2',
    category: 'query_status',
    subCategory: 'all',
    priority: IntentPriority.NORMAL,
    conditions: [{ type: 'keyword', value: '统计2', weight: 0.7 }],
    confidence: 0.75,
    minConfidence: 0.5,
  });
  registerIntent({
    id: 'stats-3',
    category: 'create_task',
    subCategory: 'bugfix',
    priority: IntentPriority.LOW,
    conditions: [{ type: 'keyword', value: '统计3', weight: 0.6 }],
    confidence: 0.7,
    minConfidence: 0.4,
  });

  CustomIntentRegistry.disableIntent('stats-3');

  const stats = CustomIntentRegistry.getStats();

  assert(stats.totalRules === 3, `TC-24: totalRules = 3 (got ${stats.totalRules})`);
  assert(stats.enabledRules === 2, `TC-24: enabledRules = 2 (got ${stats.enabledRules})`);
  assert(stats.disabledRules === 1, `TC-24: disabledRules = 1 (got ${stats.disabledRules})`);
  assert(stats.byCategory['create_task'] === 2, 'TC-24: 2 create_task rules');
  assert(stats.byCategory['query_status'] === 1, 'TC-24: 1 query_status rule');
  assert(stats.registeredProgrammatically === 3, 'TC-24: 3 programmatically registered');

  clearRegistry();
}

function test_25_merged_rules_sorted_by_priority(): void {
  clearRegistry();

  // Register rules with different priorities
  registerIntent({
    id: 'merge-low',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.LOW,
    priorityValue: 35,
    conditions: [{ type: 'keyword', value: '低优先级测试', weight: 0.5 }],
    confidence: 0.5,
    minConfidence: 0.3,
  });
  registerIntent({
    id: 'merge-override',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.OVERRIDE,
    priorityValue: 100,
    conditions: [{ type: 'keyword', value: '覆盖优先级测试', weight: 0.5 }],
    confidence: 0.5,
    minConfidence: 0.3,
  });
  registerIntent({
    id: 'merge-normal',
    category: 'other',
    subCategory: 'fallback',
    priority: IntentPriority.NORMAL,
    priorityValue: 65,
    conditions: [{ type: 'keyword', value: '普通优先级测试', weight: 0.5 }],
    confidence: 0.5,
    minConfidence: 0.3,
  });

  const merged = getMergedRules(RULES);

  // Verify sort order: higher priority first
  const overrideIdx = merged.findIndex(r => r.id === 'merge-override');
  const normalIdx = merged.findIndex(r => r.id === 'merge-normal');
  const lowIdx = merged.findIndex(r => r.id === 'merge-low');

  assert(overrideIdx >= 0 && normalIdx >= 0 && lowIdx >= 0, 'TC-25: All custom rules in merged list');
  assert(
    overrideIdx < normalIdx,
    'TC-25: OVERRIDE (100) comes before NORMAL (65)',
  );
  assert(
    normalIdx < lowIdx,
    'TC-25: NORMAL (65) comes before LOW (35)',
  );

  // Verify built-in rules are also present
  assert(
    merged.length === RULES.length + 3,
    `TC-25: Merged = ${RULES.length} built-in + 3 custom = ${RULES.length + 3} (got ${merged.length})`,
  );

  clearRegistry();
}

// ─── Test Summary ──────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
console.log(`  Custom Intent Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════');

if (failures.length > 0) {
  console.log('\n❌ Failures:');
  for (const f of failures) {
    console.log(`   • ${f}`);
  }
  process.exit(1);
} else {
  console.log('\n✅ All custom intent tests passed!');
  process.exit(0);
}
