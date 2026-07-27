/**
 * Claw Task Service — i18n Pattern Loader (Phase M5)
 *
 * Multi-language pattern loader that selects the appropriate rule set
 * based on locale. Falls back to Chinese (zh-CN) as the default language.
 *
 * Supported locales:
 *   - zh-CN (default) — Chinese patterns from patterns.ts
 *   - en     — English patterns from en-patterns.ts
 *
 * Architecture:
 *   PatternLoader.resolve(locale) → ClassificationRule[]
 *   The classifier injects PatternLoader to get locale-specific rules,
 *   enabling future language additions without modifying the classifier core.
 *
 * Usage:
 *   import { PatternLoader } from './i18n/pattern-loader.js';
 *   const rules = PatternLoader.resolve('en');
 *   // rules → English ClassificationRule[]
 *
 * Based on: M5 i18n framework design (2026-07-21)
 */

import { ClassificationRule } from '../types.js';
import { RULES, getRulesByPriority } from '../patterns.js';
import { EN_RULES, getEnRulesByPriority } from './en-patterns.js';

// ─── Types ─────────────────────────────────────────────────────────

/** Supported locale identifiers */
export type SupportedLocale = 'zh-CN' | 'en';

/** Locale normalization result */
interface LocaleResolution {
  /** The resolved locale */
  locale: SupportedLocale;
  /** Whether the input locale was recognized */
  recognized: boolean;
  /** Original locale string before normalization */
  original: string;
  /** Whether fallback was used */
  fellBack: boolean;
}

// ─── Locale Registry ───────────────────────────────────────────────

/**
 * Registry of locale → rule set providers.
 * Each entry returns the full rule array for that locale.
 */
const LOCALE_REGISTRY: Record<SupportedLocale, () => ClassificationRule[]> = {
  'zh-CN': () => RULES,
  'en': () => EN_RULES,
};

/**
 * Registry of locale → priority-sorted rule providers.
 */
const LOCALE_PRIORITY_REGISTRY: Record<SupportedLocale, () => ClassificationRule[]> = {
  'zh-CN': () => getRulesByPriority(),
  'en': () => getEnRulesByPriority(),
};

/**
 * Registry of locale → stats providers.
 */
const LOCALE_STATS_REGISTRY: Record<SupportedLocale, () => {
  totalRules: number;
  totalTriggerWords: number;
  byCategory: Record<string, number>;
  categories: string[];
}> = {
  'zh-CN': () => {
    const byCategory: Record<string, number> = {};
    const triggerWords = new Set<string>();
    for (const rule of RULES) {
      byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
      for (const cond of rule.conditions) {
        if (cond.type !== 'negation') triggerWords.add(cond.value);
      }
    }
    return {
      totalRules: RULES.length,
      totalTriggerWords: triggerWords.size,
      byCategory,
      categories: Object.keys(byCategory),
    };
  },
  'en': () => {
    const byCategory: Record<string, number> = {};
    const triggerWords = new Set<string>();
    for (const rule of EN_RULES) {
      byCategory[rule.category] = (byCategory[rule.category] || 0) + 1;
      for (const cond of rule.conditions) {
        if (cond.type !== 'negation') triggerWords.add(cond.value);
      }
    }
    return {
      totalRules: EN_RULES.length,
      totalTriggerWords: triggerWords.size,
      byCategory,
      categories: Object.keys(byCategory),
    };
  },
};

// ─── Default locale ────────────────────────────────────────────────

/** Default locale when none specified or unrecognized */
const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';

// ─── Locale Normalization ──────────────────────────────────────────

/**
 * Normalize various locale string formats to a SupportedLocale.
 *
 * Handles:
 *   - 'en', 'en-US', 'en_GB' → 'en'
 *   - 'zh', 'zh-CN', 'zh-TW', 'zh-HK' → 'zh-CN'
 *   - Empty/undefined/null → default (zh-CN)
 *   - Unknown → default (zh-CN) with fellBack=true
 */
export function normalizeLocale(input: string | undefined | null): LocaleResolution {
  const original = input ?? '';

  if (!original || original.trim() === '') {
    return {
      locale: DEFAULT_LOCALE,
      recognized: false,
      original,
      fellBack: true,
    };
  }

  const lower = original.trim().toLowerCase();

  // English: en, en-US, en_GB, en-US, etc.
  if (lower.startsWith('en')) {
    return { locale: 'en', recognized: true, original, fellBack: false };
  }

  // Chinese: zh, zh-CN, zh-TW, zh-HK, zh-CN, etc.
  if (lower.startsWith('zh')) {
    return { locale: 'zh-CN', recognized: true, original, fellBack: false };
  }

  // Unknown locale → fallback to default
  return {
    locale: DEFAULT_LOCALE,
    recognized: false,
    original,
    fellBack: true,
  };
}

// ─── Pattern Loader API ────────────────────────────────────────────

/**
 * Resolve rules for a given locale (unsorted, original order).
 *
 * @param locale - Locale string (e.g. 'en', 'zh-CN', 'en-US')
 * @returns ClassificationRule[] for the resolved locale
 */
export function resolveRules(locale?: string): ClassificationRule[] {
  const { locale: resolved } = normalizeLocale(locale);
  const provider = LOCALE_REGISTRY[resolved];
  return provider();
}

/**
 * Resolve rules for a given locale, sorted by priority descending.
 *
 * @param locale - Locale string (e.g. 'en', 'zh-CN', 'en-US')
 * @returns ClassificationRule[] sorted by priority descending
 */
export function resolveRulesByPriority(locale?: string): ClassificationRule[] {
  const { locale: resolved } = normalizeLocale(locale);
  const provider = LOCALE_PRIORITY_REGISTRY[resolved];
  return provider();
}

/**
 * Get rule statistics for a given locale.
 *
 * @param locale - Locale string (e.g. 'en', 'zh-CN', 'en-US')
 * @returns Stats object with totalRules, totalTriggerWords, byCategory, categories
 */
export function getLocaleRuleStats(locale?: string): {
  totalRules: number;
  totalTriggerWords: number;
  byCategory: Record<string, number>;
  categories: string[];
} {
  const { locale: resolved } = normalizeLocale(locale);
  const provider = LOCALE_STATS_REGISTRY[resolved];
  return provider();
}

/**
 * Get the list of supported locales.
 */
export function getSupportedLocales(): SupportedLocale[] {
  return Object.keys(LOCALE_REGISTRY) as SupportedLocale[];
}

/**
 * Check whether a locale is supported (recognized).
 */
export function isLocaleSupported(locale: string): boolean {
  return normalizeLocale(locale).recognized;
}

// ─── PatternLoader Class (injectable) ──────────────────────────────

/**
 * Injectable pattern loader for use in classifier and pipeline.
 * Encapsulates locale resolution and rule retrieval.
 */
export class PatternLoader {
  private locale: SupportedLocale;
  private rules: ClassificationRule[];
  private rulesByPriority: ClassificationRule[];

  constructor(locale?: string) {
    const resolution = normalizeLocale(locale);
    this.locale = resolution.locale;
    this.rules = resolveRules(this.locale);
    this.rulesByPriority = resolveRulesByPriority(this.locale);
  }

  /** Get the resolved locale */
  getLocale(): SupportedLocale {
    return this.locale;
  }

  /** Get all rules (original order) */
  getRules(): ClassificationRule[] {
    return this.rules;
  }

  /** Get rules sorted by priority descending */
  getRulesByPriority(): ClassificationRule[] {
    return this.rulesByPriority;
  }

  /** Get rule statistics */
  getStats() {
    return getLocaleRuleStats(this.locale);
  }

  /** Reload rules for a different locale */
  setLocale(locale: string): void {
    const resolution = normalizeLocale(locale);
    this.locale = resolution.locale;
    this.rules = resolveRules(this.locale);
    this.rulesByPriority = resolveRulesByPriority(this.locale);
  }
}
