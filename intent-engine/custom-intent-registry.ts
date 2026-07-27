/**
 * Claw Task Service — Custom Intent Registry (Phase 3 M2)
 *
 * Central registry for custom intent rules. Provides APIs for:
 *   - registerIntent(rule) / unregisterIntent(id) — runtime registration
 *   - loadRulesFromConfig(path) — hot-load rules from JSON config file
 *   - Priority queue management — custom rules sorted alongside built-in rules
 *   - Integration with existing classifier.ts via getCustomRules()
 *
 * Design principles:
 *   - Does NOT modify patterns.ts or classifier.ts core logic
 *   - Custom rules are merged with built-in rules at query time
 *   - OVERRIDE priority custom rules always evaluate before built-in rules
 *   - Thread-safe singleton pattern (single Node.js event loop)
 *   - Hot-load is atomic — all-or-nothing on config parse
 *
 * Based on: phase3-roadmap.md M2 — 自定义意图扩展机制
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  ClassificationRule,
  RuleCondition,
  TaskIntentCategory,
  TaskSubCategory,
} from './types.js';
import {
  CustomIntentRule,
  CustomIntentConfig,
  CustomIntentConfigRule,
  IntentPriority,
  RegistrationResult,
  RegistryStats,
  ValidationFunction,
  toClassificationRule,
} from './custom-intent-types.js';

// ─── Priority Mapping ──────────────────────────────────────────────

/**
 * Map IntentPriority enum to numeric priority values.
 * Built-in rules use their own numeric priority (typically 50-95).
 * OVERRIDE (100) > HIGH (85) > NORMAL (65) > LOW (35) > BUILTIN (0).
 */
const PRIORITY_VALUE_MAP: Record<IntentPriority, number> = {
  [IntentPriority.OVERRIDE]: 100,
  [IntentPriority.HIGH]: 85,
  [IntentPriority.NORMAL]: 65,
  [IntentPriority.LOW]: 35,
  [IntentPriority.BUILTIN]: 0,
};

/**
 * Parse a priority string from config to IntentPriority enum.
 * Accepts enum name ("OVERRIDE", "HIGH", etc.) or numeric string.
 */
function parsePriority(priority?: string | number): IntentPriority {
  if (priority === undefined || priority === null) {
    return IntentPriority.NORMAL;
  }

  if (typeof priority === 'number') {
    if (priority >= 95) return IntentPriority.OVERRIDE;
    if (priority >= 75) return IntentPriority.HIGH;
    if (priority >= 50) return IntentPriority.NORMAL;
    if (priority >= 20) return IntentPriority.LOW;
    return IntentPriority.BUILTIN;
  }

  const upper = priority.toUpperCase();
  if (upper in IntentPriority) {
    return IntentPriority[upper as keyof typeof IntentPriority];
  }

  // Try parsing as numeric string
  const num = parseInt(priority, 10);
  if (!isNaN(num)) {
    return parsePriority(num);
  }

  return IntentPriority.NORMAL;
}

// ─── Rule Validation ───────────────────────────────────────────────

/**
 * Validate a custom intent rule before registration.
 * Returns an error message if invalid, null if valid.
 */
function validateRule(
  rule: Partial<CustomIntentRule>,
  existingIds: Set<string>,
): string | null {
  if (!rule.id || typeof rule.id !== 'string' || rule.id.trim() === '') {
    return 'Rule id is required and must be a non-empty string';
  }

  if (existingIds.has(rule.id)) {
    return `Rule with id "${rule.id}" already exists. Use updateIntent() or unregister first.`;
  }

  if (!rule.category || typeof rule.category !== 'string') {
    return 'Rule category is required';
  }

  if (!rule.subCategory || typeof rule.subCategory !== 'string') {
    return 'Rule subCategory is required';
  }

  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    return 'Rule must have at least one condition';
  }

  for (let i = 0; i < rule.conditions.length; i++) {
    const cond = rule.conditions[i];
    if (!cond.type || !cond.value) {
      return `Condition ${i} is missing type or value`;
    }
    if (typeof cond.weight !== 'number' || cond.weight < 0) {
      return `Condition ${i} weight must be a non-negative number`;
    }
  }

  if (typeof rule.confidence !== 'number' || rule.confidence < 0 || rule.confidence > 1) {
    return 'Confidence must be a number in [0, 1]';
  }

  if (typeof rule.minConfidence !== 'number' || rule.minConfidence < 0 || rule.minConfidence > 1) {
    return 'MinConfidence must be a number in [0, 1]';
  }

  if (rule.confidence < rule.minConfidence) {
    return 'Confidence cannot be less than minConfidence';
  }

  return null;
}

// ─── Custom Intent Registry (Singleton) ────────────────────────────

/**
 * Singleton registry for custom intent rules.
 * Maintains an ordered map of rules sorted by priority.
 */
class CustomIntentRegistryImpl {
  /** Map of rule ID → CustomIntentRule */
  private rules = new Map<string, CustomIntentRule>();

  /** Set of rule IDs loaded from config files (for tracking) */
  private configLoadedIds = new Set<string>();

  /** Counter for total registrations (for stats) */
  private totalRegistrations = 0;

  // ── Registration API ─────────────────────────────────────────────

  /**
   * Register a new custom intent rule.
   *
   * @param ruleDef - Partial rule definition (priority defaults to NORMAL)
   * @param validator - Optional validation function (cannot be loaded from config)
   * @returns Registration result with the created rule or error message
   */
  registerIntent(
    ruleDef: Omit<CustomIntentRule, 'priorityValue' | 'enabled' | 'createdAt' | 'updatedAt'> & {
      priority?: IntentPriority;
      enabled?: boolean;
    },
    validator?: ValidationFunction,
  ): RegistrationResult {
    const existingIds = new Set(this.rules.keys());
    const error = validateRule(ruleDef, existingIds);
    if (error) {
      return { success: false, error };
    }

    const priority = ruleDef.priority ?? IntentPriority.NORMAL;
    const priorityValue = ruleDef.priorityValue ?? PRIORITY_VALUE_MAP[priority];
    const now = Date.now();

    const rule: CustomIntentRule = {
      id: ruleDef.id,
      category: ruleDef.category,
      subCategory: ruleDef.subCategory,
      priority,
      priorityValue,
      conditions: ruleDef.conditions,
      confidence: ruleDef.confidence,
      minConfidence: ruleDef.minConfidence,
      validator: validator ?? ruleDef.validator,
      enabled: ruleDef.enabled ?? true,
      rationale: ruleDef.rationale,
      source: ruleDef.source ?? 'programmatic',
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(rule.id, rule);
    this.totalRegistrations++;

    return { success: true, rule };
  }

  /**
   * Unregister a custom intent rule by ID.
   *
   * @param id - The rule ID to remove
   * @returns True if the rule was found and removed, false otherwise
   */
  unregisterIntent(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.configLoadedIds.delete(id);
    }
    return deleted;
  }

  /**
   * Update an existing custom intent rule.
   * If the rule doesn't exist, returns an error.
   *
   * @param id - The rule ID to update
   * @param updates - Partial rule updates
   * @returns Registration result with the updated rule or error
   */
  updateIntent(
    id: string,
    updates: Partial<CustomIntentRule>,
  ): RegistrationResult {
    const existing = this.rules.get(id);
    if (!existing) {
      return { success: false, error: `Rule "${id}" not found` };
    }

    const updated: CustomIntentRule = {
      ...existing,
      ...updates,
      id: existing.id, // ID cannot be changed
      updatedAt: Date.now(),
    };

    // Re-validate
    if (typeof updated.confidence !== 'number' || updated.confidence < 0 || updated.confidence > 1) {
      return { success: false, error: 'Confidence must be a number in [0, 1]' };
    }

    this.rules.set(id, updated);
    return { success: true, rule: updated };
  }

  // ── Enable / Disable ─────────────────────────────────────────────

  /**
   * Enable a custom intent rule.
   */
  enableIntent(id: string): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = true;
    rule.updatedAt = Date.now();
    return true;
  }

  /**
   * Disable a custom intent rule (temporarily, without unregistering).
   */
  disableIntent(id: string): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = false;
    rule.updatedAt = Date.now();
    return true;
  }

  // ── Query API ────────────────────────────────────────────────────

  /**
   * Get a custom intent rule by ID.
   */
  getIntent(id: string): CustomIntentRule | undefined {
    return this.rules.get(id);
  }

  /**
   * Get all registered custom intent rules (including disabled).
   */
  getAllCustomRules(): CustomIntentRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Get all enabled custom intent rules, sorted by priority descending.
   */
  getEnabledCustomRules(): CustomIntentRule[] {
    return Array.from(this.rules.values())
      .filter(r => r.enabled)
      .sort((a, b) => b.priorityValue - a.priorityValue);
  }

  /**
   * Get enabled custom rules as ClassificationRule[] for pipeline integration.
   * These can be directly fed into the existing classifier's evaluation loop.
   */
  getCustomClassificationRules(): ClassificationRule[] {
    return this.getEnabledCustomRules().map(toClassificationRule);
  }

  /**
   * Get enabled custom rules with their validators (for post-match validation).
   * Returns a tuple of [ClassificationRule, validator?] for each enabled rule.
   */
  getCustomRulesWithValidators(): Array<{
    rule: ClassificationRule;
    validator?: ValidationFunction;
    customRule: CustomIntentRule;
  }> {
    return this.getEnabledCustomRules().map(customRule => ({
      rule: toClassificationRule(customRule),
      validator: customRule.validator,
      customRule,
    }));
  }

  // ── Hot-Load API ─────────────────────────────────────────────────

  /**
   * Load custom intent rules from a JSON config file.
   * This is the "hot reload" mechanism — new rules become effective immediately.
   *
   * If a rule ID in the config already exists in the registry, it will be
   * updated. If an error occurs during parsing, no rules are loaded (atomic).
   *
   * @param configPath - Path to the JSON config file
   * @returns Number of rules loaded/updated, or -1 on error
   */
  loadRulesFromConfig(configPath: string): { loaded: number; errors: string[] } {
    const errors: string[] = [];
    const absPath = resolve(configPath);

    // Check file exists
    if (!existsSync(absPath)) {
      return { loaded: 0, errors: [`Config file not found: ${absPath}`] };
    }

    // Read and parse JSON
    let config: CustomIntentConfig;
    try {
      const content = readFileSync(absPath, 'utf-8');
      config = JSON.parse(content) as CustomIntentConfig;
    } catch (e) {
      return {
        loaded: 0,
        errors: [`Failed to parse config: ${(e as Error).message}`],
      };
    }

    if (!config.rules || !Array.isArray(config.rules)) {
      return { loaded: 0, errors: ['Config must contain a "rules" array'] };
    }

    // First pass: validate all rules (atomic — all or nothing)
    const tempIds = new Set(this.rules.keys());
    const validRules: CustomIntentConfigRule[] = [];

    for (let i = 0; i < config.rules.length; i++) {
      const ruleDef = config.rules[i];
      // Allow existing IDs for update (remove from tempIds to skip duplicate check)
      tempIds.delete(ruleDef.id);

      const error = validateRule(ruleDef, tempIds);
      if (error) {
        errors.push(`Rule ${i} (${ruleDef.id || 'unnamed'}): ${error}`);
      } else {
        validRules.push(ruleDef);
        tempIds.add(ruleDef.id);
      }
    }

    if (errors.length > 0 && validRules.length === 0) {
      return { loaded: 0, errors };
    }

    // Second pass: register all valid rules
    let loaded = 0;
    for (const ruleDef of validRules) {
      const priority = parsePriority(ruleDef.priority);
      const priorityValue = ruleDef.priorityValue ?? PRIORITY_VALUE_MAP[priority];
      const now = Date.now();

      const existing = this.rules.get(ruleDef.id);
      const rule: CustomIntentRule = {
        id: ruleDef.id,
        category: ruleDef.category,
        subCategory: ruleDef.subCategory,
        priority,
        priorityValue,
        conditions: ruleDef.conditions,
        confidence: ruleDef.confidence,
        minConfidence: ruleDef.minConfidence,
        validator: undefined, // Validators cannot be loaded from config
        enabled: existing?.enabled ?? true,
        rationale: ruleDef.rationale,
        source: ruleDef.source ?? `config:${absPath}`,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      this.rules.set(rule.id, rule);
      this.configLoadedIds.add(rule.id);
      loaded++;
    }

    return { loaded, errors };
  }

  /**
   * Load rules from a config object (in-memory).
   * Useful for testing or programmatic bulk registration.
   */
  loadRulesFromObject(config: CustomIntentConfig): { loaded: number; errors: string[] } {
    const errors: string[] = [];

    if (!config.rules || !Array.isArray(config.rules)) {
      return { loaded: 0, errors: ['Config must contain a "rules" array'] };
    }

    const tempIds = new Set(this.rules.keys());
    const validRules: CustomIntentConfigRule[] = [];

    for (let i = 0; i < config.rules.length; i++) {
      const ruleDef = config.rules[i];
      tempIds.delete(ruleDef.id);
      const error = validateRule(ruleDef, tempIds);
      if (error) {
        errors.push(`Rule ${i} (${ruleDef.id || 'unnamed'}): ${error}`);
      } else {
        validRules.push(ruleDef);
        tempIds.add(ruleDef.id);
      }
    }

    if (errors.length > 0 && validRules.length === 0) {
      return { loaded: 0, errors };
    }

    let loaded = 0;
    for (const ruleDef of validRules) {
      const priority = parsePriority(ruleDef.priority);
      const priorityValue = ruleDef.priorityValue ?? PRIORITY_VALUE_MAP[priority];
      const now = Date.now();

      const existing = this.rules.get(ruleDef.id);
      const rule: CustomIntentRule = {
        id: ruleDef.id,
        category: ruleDef.category,
        subCategory: ruleDef.subCategory,
        priority,
        priorityValue,
        conditions: ruleDef.conditions,
        confidence: ruleDef.confidence,
        minConfidence: ruleDef.minConfidence,
        validator: undefined,
        enabled: existing?.enabled ?? true,
        rationale: ruleDef.rationale,
        source: ruleDef.source ?? 'object',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      this.rules.set(rule.id, rule);
      loaded++;
    }

    return { loaded, errors };
  }

  // ── Bulk Operations ──────────────────────────────────────────────

  /**
   * Unregister all custom rules.
   * Does not affect built-in rules from patterns.ts.
   */
  clearAll(): void {
    this.rules.clear();
    this.configLoadedIds.clear();
  }

  /**
   * Unregister all rules that were loaded from config files.
   */
  clearConfigLoaded(): void {
    for (const id of this.configLoadedIds) {
      this.rules.delete(id);
    }
    this.configLoadedIds.clear();
  }

  // ── Statistics ───────────────────────────────────────────────────

  /**
   * Get statistics about the custom intent registry.
   */
  getStats(): RegistryStats {
    const allRules = Array.from(this.rules.values());
    const enabled = allRules.filter(r => r.enabled);
    const disabled = allRules.filter(r => !r.enabled);

    const byPriority: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const rule of allRules) {
      const priorityName = Object.keys(IntentPriority).find(
        k => IntentPriority[k as keyof typeof IntentPriority] === rule.priority,
      ) ?? 'UNKNOWN';
      byPriority[priorityName] = (byPriority[priorityName] || 0) + 1;
      byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
    }

    return {
      totalRules: allRules.length,
      enabledRules: enabled.length,
      disabledRules: disabled.length,
      byPriority,
      byCategory,
      loadedFromConfig: this.configLoadedIds.size,
      registeredProgrammatically: allRules.length - this.configLoadedIds.size,
    };
  }

  // ── Priority Queue Management ────────────────────────────────────

  /**
   * Get all rules (built-in + custom) merged and sorted by priority.
   * This is the primary integration point with the classifier.
   *
   * @param builtinRules - Built-in rules from patterns.ts
   * @returns All rules sorted by priority descending, with custom OVERRIDE rules first
   */
  getMergedRules(builtinRules: ClassificationRule[]): ClassificationRule[] {
    const customRules = this.getCustomClassificationRules();
    const all = [...customRules, ...builtinRules];
    return all.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get rules with validator info, merged with built-in rules.
   * Built-in rules have no validator (always pass).
   */
  getMergedRulesWithValidators(
    builtinRules: ClassificationRule[],
  ): Array<{
    rule: ClassificationRule;
    validator?: ValidationFunction;
  }> {
    const customEntries = this.getCustomRulesWithValidators().map(({ rule, validator }) => ({
      rule,
      validator,
    }));
    const builtinEntries = builtinRules.map(rule => ({ rule, validator: undefined }));

    return [...customEntries, ...builtinEntries].sort(
      (a, b) => b.rule.priority - a.rule.priority,
    );
  }
}

// ─── Singleton Export ──────────────────────────────────────────────

/**
 * Global singleton instance of the custom intent registry.
 * Import this to register, unregister, or query custom intent rules.
 */
export const CustomIntentRegistry = new CustomIntentRegistryImpl();

// ─── Convenience API ───────────────────────────────────────────────

/**
 * Register a custom intent rule (shorthand).
 */
export function registerIntent(
  ruleDef: Parameters<CustomIntentRegistryImpl['registerIntent']>[0],
  validator?: ValidationFunction,
): RegistrationResult {
  return CustomIntentRegistry.registerIntent(ruleDef, validator);
}

/**
 * Unregister a custom intent rule by ID (shorthand).
 */
export function unregisterIntent(id: string): boolean {
  return CustomIntentRegistry.unregisterIntent(id);
}

/**
 * Get all enabled custom rules as ClassificationRule[] (shorthand).
 * Use this in classifier.ts to merge with built-in rules.
 */
export function getCustomRules(): ClassificationRule[] {
  return CustomIntentRegistry.getCustomClassificationRules();
}

/**
 * Load rules from a JSON config file (shorthand).
 */
export function loadRulesFromConfig(
  configPath: string,
): { loaded: number; errors: string[] } {
  return CustomIntentRegistry.loadRulesFromConfig(configPath);
}

/**
 * Get merged rules (built-in + custom) sorted by priority (shorthand).
 */
export function getMergedRules(builtinRules: ClassificationRule[]): ClassificationRule[] {
  return CustomIntentRegistry.getMergedRules(builtinRules);
}
