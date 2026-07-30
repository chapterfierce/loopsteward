# I18N Guide — Internationalization & Multi-Language Support

**Version:** 2.5.0 (Phase 3 M5)  
**Last Updated:** 2026-07-30

---

## 目录

1. [Overview](#overview)
2. [Supported Languages](#supported-languages)
3. [Date Formats by Language](#date-formats-by-language)
4. [Architecture](#architecture)
5. [Adding a New Language](#adding-a-new-language)
6. [Known Limitations](#known-limitations)
7. [FAQ](#faq)

---

## Overview

Claw Task Service 支持多语言意图分类。内置中文（zh-CN）和英文（en）两套规则集，通过语言检测和路由机制自动选择合适的规则集。

i18n 框架由以下模块组成：

| Module | File | Description |
|--------|------|-------------|
| Language Detector | `lang-detector.ts` | 基于字符分类的快速语言检测（zh/en/mixed/unknown） |
| Language Router | `lang-router.ts` | 语言路由：显式 locale > 自动检测 > 默认值 |
| Pattern Loader | `i18n/pattern-loader.ts` | 本地化规则集加载器 |
| EN Patterns | `i18n/en-patterns.ts` | 英文规则集（22 rules） |
| ZH Patterns | `patterns.ts` | 中文规则集（22 rules） |
| Date Parser ZH | `i18n/date-parser-zh.ts` | 中文日期解析器 |
| Date Parser EN | `i18n/date-parser-en.ts` | 英文日期解析器 |

---

## Supported Languages

| Locale | Language | Rule Count | Status |
|--------|----------|------------|--------|
| `zh-CN` | Chinese (Simplified) | 22 | ✅ Default, pre-compiled |
| `en` | English | 22 | ✅ Full support |

### Locale Normalization

The `normalizeLocale()` function accepts various locale formats:

| Input | Resolved Locale | Method |
|-------|----------------|--------|
| `en` | `en` | Direct match |
| `en-US` | `en` | Prefix match |
| `en_GB` | `en` | Prefix match |
| `zh` | `zh-CN` | Prefix match |
| `zh-CN` | `zh-CN` | Direct match |
| `zh-TW` | `zh-CN` | Prefix match (fallback) |
| `zh-HK` | `zh-CN` | Prefix match (fallback) |
| `fr`, `ja`, `ko` | `zh-CN` | Unknown → fallback |
| `""`, `null`, `undefined` | `zh-CN` | Empty → fallback |

---

## Date Formats by Language

### Chinese (zh-CN)

| Pattern | Example Input | Resolved Date |
|---------|---------------|---------------|
| 相对天数 | 今天 / 明天 / 后天 / 大后天 | +0 / +1 / +2 / +3 days |
| 本周 | 周一..周日 (周一..星期日) | Upcoming occurrence (never today) |
| 下周 | 下周一..下周日 | Strictly next week's day |
| 本月 | 本月15号 / 本月3日 | Current month, given day |
| 下月 | 下个月3日 / 下月15号 | Next month, given day |
| 绝对月日 | 8月20日 / 12月5日 / 3月15号 | Current year, given month+day |
| ISO日期 | 2026-07-30 / 2026年7月28日 / 2026/7/28 | Exact date |
| 时间段 | 上午9点 / 下午2点半 / 晚上8点 / 早上7:30 | Today at given time |
| 相对时长 | 30分钟后 / 2小时15分钟后 / 3周后 / 2个月后 | Duration from now |

### English (en)

| Pattern | Example Input | Resolved Date |
|---------|---------------|---------------|
| Relative | today / tomorrow / day after tomorrow / yesterday | ±0/1/2 days |
| Next weekday | next Monday / next Friday | Strictly next week's day |
| This weekday | this Friday / on Friday / Friday | Upcoming occurrence |
| Relative periods | next week / next month | Start of next period |
| Relative duration | in 3 days / in two weeks / in one month | Duration from now |
| Later/ago | 3 days later / 2 weeks from now | Duration from now |

---

## Architecture

```
User Input
    │
    ▼
┌──────────────────────┐
│  Language Detector    │  Detect zh/en/mixed/unknown
│  (lang-detector.ts)   │  ~1-5μs per detection
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Language Router      │  Resolve locale:
│  (lang-router.ts)     │  explicit > detected > fallback(zh-CN)
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Pattern Loader       │  Select rule set by locale
│  (pattern-loader.ts)  │  zh-CN → pre-compiled fast path
│                       │  en → i18n English rules
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Classifier           │  Rule matching + disambiguation
│  (classifier.ts)      │  Output: IntentResult with locale meta
└──────────────────────┘
```

### Language Detection Algorithm

The detector uses a single-pass character-class counter:

1. Count CJK characters (`zhCount`) and Latin letters (`enCount`)
2. Apply weight: `zhScore = zhCount × 2` (CJK chars carry more information per character)
3. Compute weighted ratios
4. Classify:
   - **zh**: CJK dominant, minority < threshold
   - **en**: Latin dominant, minority < threshold
   - **mixed**: Both scripts above threshold (minority ≥ 2 chars AND ≥ 15% weighted ratio)
   - **unknown**: No CJK or Latin characters

### Routing Rules

| Detection | Dominant | Routed Locale | Source |
|-----------|----------|---------------|--------|
| zh | zh | zh-CN | detected |
| en | en | en | detected |
| mixed | zh | zh-CN | detected |
| mixed | en | en | detected |
| unknown | none | zh-CN | fallback |
| (explicit) | — | (explicit) | explicit |

**Priority:** Explicit `request.locale` > Auto-detected > Default (zh-CN)

---

## Adding a New Language

To add support for a new language (e.g., Japanese — `ja`), follow these steps:

### Step 1: Create a Tokenizer / Language Detector Extension

Add the new language to the `DetectedLang` type in `lang-detector.ts`:

```typescript
export type DetectedLang = 'zh' | 'en' | 'mixed' | 'unknown' | 'ja';
```

Add CJK detection for Japanese-specific ranges (Hiragana, Katakana):

```typescript
function isJapanese(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff)    // Katakana
  );
}
```

### Step 2: Create a Pattern Set

Create `i18n/ja-patterns.ts` with 22 rules matching the Chinese and English rule sets:

```typescript
import { ClassificationRule } from '../types.js';

export const JA_RULES: ClassificationRule[] = [
  {
    id: 'create-task-explicit-ja',
    category: 'create_task',
    subCategory: 'general',
    priority: 85,
    conditions: [
      { type: 'keyword', value: '作成', weight: 1.0 },
      { type: 'keyword', value: '追加', weight: 0.9 },
      { type: 'keyword', value: '新規', weight: 0.95 },
      // ... more Japanese trigger words
    ],
    confidence: 0.90,
    minConfidence: 0.6,
    rationale: 'Explicit task creation keyword detected (JA)',
  },
  // ... 21 more rules covering all 11 categories
];
```

**Key Principles:**
- All 11 intent categories must be covered (create_task, query_status, modify_task, delete_task, schedule, debug, development, research, review, planning, other)
- Trigger words should be **natural expressions** in the target language, not literal translations
- Rule count should match zh-CN (22 rules) for functional parity
- Negation conditions help disambiguate overlapping intents

### Step 3: Create a Date Parser (Optional)

If the language has date expressions not covered by ISO format, create `i18n/date-parser-ja.ts`:

```typescript
export interface ParsedJaDate {
  matched: string;
  index: number;
  date: Date;
  isoDate: string;
  kind: string;
  confidence: number;
}

export function extractJapaneseDates(
  text: string,
  now: Date = new Date(),
): ParsedJaDate[] {
  // Pattern matching for: 今日, 明日, 来週月曜日, etc.
}
```

### Step 4: Register in Pattern Loader

Add the new locale to `i18n/pattern-loader.ts`:

```typescript
export type SupportedLocale = 'zh-CN' | 'en' | 'ja-JP';

const LOCALE_REGISTRY: Record<SupportedLocale, () => ClassificationRule[]> = {
  'zh-CN': () => RULES,
  'en': () => EN_RULES,
  'ja-JP': () => JA_RULES,
};
```

### Step 5: Register Language Route

Add the new language to `lang-router.ts`:

```typescript
const LANG_ROUTES: Map<...> = new Map([
  ['zh', 'zh-CN'],
  ['en', 'en'],
  ['ja', 'ja-JP'],     // ← New route
  ['unknown', DEFAULT_LOCALE],
]);
```

### Step 6: Write Tests

Create `i18n/__tests__/ja-patterns.test.ts` with at least 6 test cases covering:
- Pattern loader resolves `ja-JP` correctly
- Rule count matches zh-CN
- Categories match zh-CN
- Sample classification produces correct results
- Backward compatibility (zh-CN and en still work)

Run: `npx tsx i18n/__tests__/ja-patterns.test.ts`

### Step 7: Update `normalizeLocale`

In `pattern-loader.ts`, add the new prefix:

```typescript
if (lower.startsWith('ja')) {
  return { locale: 'ja-JP', recognized: true, original, fellBack: false };
}
```

---

## Known Limitations

### 1. Chinese Date Parser — Relative Month Pattern Overlap

The `N个月后` (N months later) pattern uses `\d+个月?` which can match the month portion of absolute date expressions like `13月15日`. In practice, `13月` is interpreted as "13 months later" rather than being rejected as an invalid month. This is a known design trade-off — the relative pattern fires before the absolute month-day pattern.

**Workaround:** Use ISO format (`2026-07-15`) or `本月15号` for unambiguous absolute dates.

### 2. Mixed Language — Dominant Script Wins

When input is mixed (e.g., `修复登录bug`), the routing is based on the **dominant script**. Chinese-dominant mixed input uses zh-CN rules; English-dominant mixed input uses en rules. A small number of foreign characters (< 2 chars or < 15% weighted ratio) does not trigger mixed routing.

### 3. No Bidirectional Support

The framework does not support bidirectional (RTL) languages like Arabic or Hebrew. The character-class detector only covers CJK and Latin scripts.

### 4. English Date Parser — No Time of Day

The English date parser (`date-parser-en.ts`) handles date expressions only. Time-of-day parsing (e.g., "3pm", "9:30 AM") is not implemented. Use the Chinese time patterns or ISO datetime format for time-specific scheduling.

### 5. Chinese Numeral Parser — Limited Range

The `parseCnNum()` function handles Chinese numerals 0-99. For larger numbers (百 = 100, 千 = 1000), the parser may produce incorrect results. Use Arabic digits for quantities above 99.

### 6. Locale Echo vs Normalization

When an explicit locale is passed (e.g., `en-US`), the `meta.locale` field echoes the **original string**, not the normalized locale. The internal normalization (`en`) is used for rule selection but not exposed in the result metadata. This is intentional to preserve the user's original input for debugging.

### 7. No Automatic Rule Translation

English rules are not auto-translated from Chinese rules. Each rule set is independently authored with natural trigger words for the target language. This means rule maintenance is O(n) per language added.

### 8. Performance — Pre-compiled Fast Path Only for zh-CN

The regex pre-compilation pool (`regex-pool.ts`) only covers zh-CN rules. English rules use on-the-fly evaluation which is ~2-3x slower but still well under 1ms per classification.

---

## FAQ

### Q1: How does the system handle mixed-language input like "修复登录bug"?

The language detector classifies it as `mixed` with `dominant=zh`. The router resolves it to `zh-CN` because zh-dominant mixed input uses the Chinese rule set. The English word "bug" is tokenized and matched as a keyword within the Chinese rules (the `create-task-bugfix` rule has `bug` as a trigger keyword).

### Q2: Can I force a specific locale for all input?

Yes. Set `request.locale` explicitly:

```typescript
const result = classify({ text: 'create task', locale: 'zh-CN' });
```

Or disable auto-detection:

```typescript
const classifier = new RuleClassifier({ autoDetectLanguage: false, defaultLocale: 'en' });
```

### Q3: What happens when an unknown locale is passed?

The `normalizeLocale()` function falls back to `zh-CN` with `fellBack=true`. The classification proceeds normally with Chinese rules.

### Q4: How do I add custom trigger words for an existing language?

Edit the rule definitions in `patterns.ts` (Chinese) or `i18n/en-patterns.ts` (English). Add a new condition object to the relevant rule:

```typescript
{ type: 'keyword', value: '新触发词', weight: 0.8 },
```

### Q5: What's the performance overhead of language detection?

Typically 0.2-5μs per call for inputs under 200 characters. The detector is a single-pass loop over `charCodeAt` values with constant-time range checks. No dictionaries or ML models are used.

### Q6: Can I use the date parsers independently of the classifier?

Yes. Both `date-parser-zh.ts` and `date-parser-en.ts` are pure functions of `(text, now)` with no dependencies on the classifier. Import and call directly:

```typescript
import { parseChineseDate } from './i18n/date-parser-zh.js';
import { parseEnglishDate } from './i18n/date-parser-en.js';

const date = parseChineseDate('明天下午3点', new Date());
```

### Q7: Why does `meta.locale` show `en-US` instead of `en`?

The metadata preserves the original locale string from the request for debugging. The internal normalization to `en` is used for rule selection only. See [Known Limitations §6](#6-locale-echo-vs-normalization).

### Q8: How are confidence scores affected by language?

Confidence scoring is language-independent. The same rule structure produces equivalent confidence values across languages, because the scoring algorithm uses condition weights, not the trigger words themselves.
