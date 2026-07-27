/**
 * Claw Task Service — Language Router (Phase 3 M5)
 *
 * Routing layer between raw user input and locale-specific rule sets.
 *
 * Responsibilities:
 *   1. Resolve the effective locale for a classification request:
 *        explicit request.locale  >  auto-detected language  >  default locale
 *   2. Map detected languages (zh/en/mixed/unknown) to registered locales.
 *      'mixed' routes to the DOMINANT script's locale, so "修复登录bug"
 *      (zh-dominant) still uses the Chinese rule set.
 *   3. Provide a registration mechanism so future languages (ja, ko, …)
 *      can be added without touching the classifier core:
 *        registerLanguageRoute('ja', 'ja-JP')  +  PatternLoader registry entry.
 *
 * Fallback chain:
 *   detected lang has no registered route → DEFAULT locale (zh-CN).
 */

import { detectLanguage, DetectedLang, LangDetectionResult } from './lang-detector';
import { normalizeLocale } from './i18n/pattern-loader';

// ─── Types ──────────────────────────────────────────────────────────

/** Result of locale routing */
export interface RouteResult {
  /** The locale the classifier should use (e.g. 'zh-CN', 'en') */
  locale: string;
  /** How the locale was determined */
  source: 'explicit' | 'detected' | 'fallback';
  /** The underlying language detection result (present unless explicit) */
  detection?: LangDetectionResult;
}

// ─── Route Registry ─────────────────────────────────────────────────

/** Default locale used when no route matches */
const DEFAULT_LOCALE = 'zh-CN';

/**
 * lang → locale routing table.
 * 'mixed' is resolved dynamically via the dominant script.
 */
const LANG_ROUTES: Map<Exclude<DetectedLang, 'mixed'>, string> = new Map([
  ['zh', 'zh-CN'],
  ['en', 'en'],
  ['unknown', DEFAULT_LOCALE],
]);

/**
 * Register (or override) a language → locale route.
 * To fully support a new language you must also register its rule set
 * in the i18n PatternLoader locale registry.
 *
 * @param lang - Detected language key ('zh' | 'en' | 'unknown')
 * @param locale - Target locale identifier
 */
export function registerLanguageRoute(
  lang: Exclude<DetectedLang, 'mixed'>,
  locale: string,
): void {
  LANG_ROUTES.set(lang, locale);
}

/**
 * Get a snapshot of the current routing table (for diagnostics).
 */
export function getLanguageRoutes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of LANG_ROUTES) out[k] = v;
  return out;
}

// ─── Routing Core ───────────────────────────────────────────────────

/**
 * Route a detected language to a locale.
 * 'mixed' → dominant script's route; unregistered → DEFAULT_LOCALE.
 */
export function routeLang(detection: LangDetectionResult): string {
  let key: Exclude<DetectedLang, 'mixed'>;
  if (detection.lang === 'mixed') {
    key = detection.dominant === 'en' ? 'en' : 'zh';
  } else {
    key = detection.lang;
  }
  return LANG_ROUTES.get(key) ?? DEFAULT_LOCALE;
}

/**
 * Resolve the effective locale for a request.
 *
 * Priority:
 *   1. explicit locale (if provided and recognized by the pattern loader)
 *   2. auto-detected language route
 *   3. default locale
 *
 * @param text - Raw user input text
 * @param explicitLocale - Optional locale from the request
 */
export function resolveRequestLocale(
  text: string,
  explicitLocale?: string,
): RouteResult {
  // 1. Explicit locale wins when it is a recognized locale
  if (explicitLocale) {
    const { recognized } = normalizeLocale(explicitLocale);
    if (recognized) {
      return { locale: explicitLocale, source: 'explicit' };
    }
    // Unrecognized explicit locale → fall through to detection
  }

  // 2. Auto-detect from text
  const detection = detectLanguage(text);
  if (detection.lang !== 'unknown') {
    return { locale: routeLang(detection), source: 'detected', detection };
  }

  // 3. Fallback
  return { locale: DEFAULT_LOCALE, source: 'fallback', detection };
}
