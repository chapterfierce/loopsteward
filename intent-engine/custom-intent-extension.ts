/**
 * Claw Task Service — Custom Intent Extension API (Phase 3 M2)
 *
 * Public extension API for the custom intent mechanism.
 * This is the primary entry point for external consumers who want to
 * register, query, or manage custom intent rules at runtime.
 *
 * Design goals:
 *   - Type-safe: all public APIs are fully typed
 *   - Non-invasive: does NOT modify existing classifier.ts / pipeline.ts core
 *   - Integration-ready: wired into classifier via matchAllRules() extension
 *   - Hot-reload capable: supports loading rules from JSON config at runtime
 *
 * Usage:
 *   import { extension, IntentPriority } from './custom-intent-extension.js';
 *
 *   // Register a custom rule
 *   extension.register({ id: 'my-rule', category: 'development', ... });
 *
 *   // Load rules from config
 *   extension.loadFromConfig('/path/to/rules.json');
 *
 *   // Query registry
 *   const stats = extension.getStats();
 *
 * Based on: phase3-roadmap.md M2 — 自定义意图扩展机制
 */

import {
  CustomIntentRegistry,
  registerIntent,
  unregisterIntent,
  getCustomRules,
  getMergedRules,
  loadRulesFromConfig,
} from './custom-intent-registry.js';
import type {
  CustomIntentRule,
  ValidationFunction,
} from './custom-intent-types.js';
import { toClassificationRule } from './custom-intent-types.js';
import type { ClassificationRule } from './types.js';

// IntentPriority is imported as a VALUE (not just type) because it is an enum
// used at runtime for priority comparisons and conditional logic.
// custom-intent-registry.js re-exports it from custom-intent-types.js as a value
// so that it survives TypeScript compilation and is available at runtime.
import { IntentPriority } from './custom-intent-registry.js';

// ─── Rule definition (what callers pass to register) ───────────────

/**
 * Partial rule definition for registration.
 * priority, priorityValue, enabled, validator are all optional.
 */
export type CustomRuleDefinition =
  & Omit<CustomIntentRule, 'priorityValue' | 'enabled' | 'createdAt' | 'updatedAt'>
  & {
    priority?: IntentPriority;
    priorityValue?: number;
    enabled?: boolean;
    validator?: ValidationFunction;
  };

// ─── Extension API ─────────────────────────────────────────────────

/**
 * The custom intent extension API.
 *
 * This is the primary public interface for the M2 extension mechanism.
 * It wraps the internal CustomIntentRegistry with a clean, type-safe API.
 */
export interface CustomIntentExtension {
  /**
   * Register a new custom intent rule.
   *
   * @param rule - Rule definition (id, category, subCategory, conditions required)
   * @param validator - Optional validation function for programmatic post-match checks
   * @returns Registration result with the created rule or error message
   *
   * @example
   *   const result = extension.register({
   *     id: 'deploy-rule',
   *     category: 'development',
   *     subCategory: 'feature_impl',
   *     conditions: [{ type: 'keyword', value: '部署', weight: 0.9 }],
   *     confidence: 0.88,
   *     minConfidence: 0.6,
   *   });
   */
  register(
    rule: CustomRuleDefinition,
    validator?: ValidationFunction,
  ): { success: boolean; rule?: CustomIntentRule; error?: string };

  /**
   * Unregister a custom intent rule by ID.
   *
   * @param id - The rule ID to remove
   * @returns True if removed, false if not found
   */
  unregister(id: string): boolean;

  /**
   * Update an existing custom intent rule.
   *
   * @param id - The rule ID to update
   * @param updates - Partial rule updates
   * @returns Updated rule or error
   */
  update(
    id: string,
    updates: Partial<CustomIntentRule>,
  ): { success: boolean; rule?: CustomIntentRule; error?: string };

  /**
   * Enable a disabled rule.
   *
   * @param id - Rule ID to enable
   * @returns True if found and enabled, false otherwise
   */
  enable(id: string): boolean;

  /**
   * Disable a rule (temporarily, without removing it from the registry).
   *
   * @param id - Rule ID to disable
   * @returns True if found and disabled, false otherwise
   */
  disable(id: string): boolean;

  /**
   * Get a custom rule by ID.
   *
   * @param id - The rule ID
   * @returns The rule if found, undefined otherwise
   */
  get(id: string): CustomIntentRule | undefined;

  /**
   * Get all enabled custom rules as ClassificationRule[].
   * These can be merged with built-in rules in the classifier.
   *
   * @returns All enabled custom rules sorted by priority descending
   */
  getEnabledRules(): ClassificationRule[];

  /**
   * Get merged rules (built-in + custom), sorted by priority descending.
   * OVERRIDE-priority custom rules always come first.
   *
   * @param builtinRules - Built-in rules from patterns.ts
   * @returns All rules (built-in + custom) sorted by priority
   */
  getMergedRules(builtinRules: ClassificationRule[]): ClassificationRule[];

  /**
   * Load custom intent rules from a JSON config file (hot-reload).
   * Rules take effect immediately on successful load.
   *
   * @param configPath - Absolute or relative path to the JSON config file
   * @returns { loaded: number of rules, errors: string[] }
   */
  loadFromConfig(
    configPath: string,
  ): { loaded: number; errors: string[] };

  /**
   * Load rules from a plain object (programmatic bulk registration).
   * Useful for testing or dynamic config generation.
   *
   * @param config - CustomIntentConfig object
   * @returns { loaded: number of rules, errors: string[] }
   */
  loadFromObject(
    config: { version?: string; rules: unknown[] },
  ): { loaded: number; errors: string[] };

  /**
   * Clear all custom rules from the registry.
   * Built-in rules from patterns.ts are not affected.
   */
  clearAll(): void;

  /**
   * Get statistics about the custom intent registry.
   */
  getStats(): {
    totalRules: number;
    enabledRules: number;
    disabledRules: number;
    byPriority: Record<string, number>;
    byCategory: Record<string, number>;
  };

  /** Internal registry instance (for advanced use) */
  readonly _registry: typeof CustomIntentRegistry;
}

// ─── Extension Implementation ────────────────────────────────────────

const extension: CustomIntentExtension = {
  register(rule, validator) {
    return CustomIntentRegistry.registerIntent(rule, validator);
  },

  unregister(id) {
    return CustomIntentRegistry.unregisterIntent(id);
  },

  update(id, updates) {
    return CustomIntentRegistry.updateIntent(id, updates);
  },

  enable(id) {
    return CustomIntentRegistry.enableIntent(id);
  },

  disable(id) {
    return CustomIntentRegistry.disableIntent(id);
  },

  get(id) {
    return CustomIntentRegistry.getIntent(id);
  },

  getEnabledRules() {
    return CustomIntentRegistry.getCustomClassificationRules();
  },

  getMergedRules(builtinRules) {
    return CustomIntentRegistry.getMergedRules(builtinRules);
  },

  loadFromConfig(configPath) {
    return CustomIntentRegistry.loadRulesFromConfig(configPath);
  },

  loadFromObject(config) {
    return CustomIntentRegistry.loadRulesFromObject(
      config as Parameters<typeof CustomIntentRegistry.loadRulesFromObject>[0],
    );
  },

  clearAll() {
    CustomIntentRegistry.clearAll();
  },

  getStats() {
    return CustomIntentRegistry.getStats();
  },

  _registry: CustomIntentRegistry,
};

// ─── Export the extension singleton + enum ──────────────────────────
//
// IntentPriority is exported HERE (as a value binding) so that consumers can:
//   import { IntentPriority } from './custom-intent-extension.js';
// and get the runtime enum object.
//
// The top-level `import { IntentPriority } from './custom-intent-registry.js'`
// brings the enum into module scope; this `export { IntentPriority }` makes it
// available to external consumers. The type re-export allows:
//   import type { IntentPriority } from './custom-intent-extension.js';
//
export { extension };
export { IntentPriority };

// ─── Convenience re-exports ────────────────────────────────────────

export {
  CustomIntentRegistry,
  registerIntent,
  unregisterIntent,
  getCustomRules,
  getMergedRules,
  loadRulesFromConfig,
} from './custom-intent-registry.js';

export type {
  CustomIntentRule,
  ValidationFunction,
  RegistrationResult,
  RegistryStats,
  CustomIntentConfig,
  CustomIntentConfigRule,
} from './custom-intent-types.js';

export { toClassificationRule } from './custom-intent-types.js';
