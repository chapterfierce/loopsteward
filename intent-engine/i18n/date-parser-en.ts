/**
 * Claw Task Service — English Date Parser (Phase 3 M5)
 *
 * Parses relative English date expressions into concrete dates.
 * The existing preprocessor/entity-extractor only handles Chinese time
 * expressions (今天/明天/下周三…); this module provides the English
 * counterpart for the i18n pipeline.
 *
 * Supported expressions:
 *   - today / tonight / tomorrow / day after tomorrow / yesterday
 *   - next Monday .. next Sunday   (strictly the following week's day)
 *   - this Friday / on Friday / Friday        (upcoming occurrence)
 *   - next week / next month
 *   - in 3 days / in three days / in 2 weeks / in a week / in one month
 *   - 3 days later / two weeks later
 *   - by Friday / before next Monday (the embedded expression is parsed)
 *
 * Pure function of (text, now) — pass `now` for deterministic tests.
 */

// ─── Types ──────────────────────────────────────────────────────────

/** A single parsed date expression */
export interface ParsedEnDate {
  /** The exact matched substring */
  matched: string;
  /** Start index of the match in the input */
  index: number;
  /** Resolved date (local midnight of the target day) */
  date: Date;
  /** ISO date string (YYYY-MM-DD) for stable comparison */
  isoDate: string;
  /** Expression kind */
  kind:
    | 'today'
    | 'tomorrow'
    | 'day_after_tomorrow'
    | 'yesterday'
    | 'weekday'
    | 'next_weekday'
    | 'next_week'
    | 'next_month'
    | 'relative_days'
    | 'relative_weeks'
    | 'relative_months';
  /** Parser confidence [0,1] */
  confidence: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Local midnight of a given date */
function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Add days to a date (returns new Date at local midnight) */
function addDays(d: Date, days: number): Date {
  const base = atMidnight(d);
  base.setDate(base.getDate() + days);
  return base;
}

/** Format YYYY-MM-DD in local time */
function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a quantity token: digits or a number word */
function parseQuantity(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  const w = NUMBER_WORDS[token.toLowerCase()];
  return w !== undefined ? w : null;
}

/**
 * Days until the upcoming occurrence of `weekday` (1-7 days ahead).
 * "this Friday" / bare "Friday": the next occurrence (never today).
 */
function daysToUpcoming(nowDow: number, target: number): number {
  let diff = (target - nowDow + 7) % 7;
  if (diff === 0) diff = 7;
  return diff;
}

/**
 * Days until "next <weekday>": strictly in the FOLLOWING calendar week
 * (next Monday on a Monday = 7 days ahead; on a Sunday = 1 day ahead is
 * ambiguous — we use "the <weekday> of next week" semantics: days until
 * next week's Monday, then offset to the target weekday).
 */
function daysToNextWeekday(nowDow: number, target: number): number {
  // Days until next week's Monday (week starts Monday)
  const daysToNextMonday = ((8 - nowDow) % 7) || 7;
  // Offset within next week: Monday=0 … Sunday=6
  const offset = (target - 1 + 7) % 7;
  return daysToNextMonday + offset;
}

// ─── Pattern Table ──────────────────────────────────────────────────

interface EnDatePattern {
  regex: RegExp;
  kind: ParsedEnDate['kind'];
  confidence: number;
  /** Compute target date from match groups */
  resolve: (m: RegExpExecArray, now: Date) => Date | null;
}

const WD = '(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)';
const QTY = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

const EN_DATE_PATTERNS: EnDatePattern[] = [
  {
    regex: /\bday\s+after\s+tomorrow\b/gi,
    kind: 'day_after_tomorrow',
    confidence: 1.0,
    resolve: (_m, now) => addDays(now, 2),
  },
  {
    regex: /\btomorrow\b/gi,
    kind: 'tomorrow',
    confidence: 1.0,
    resolve: (_m, now) => addDays(now, 1),
  },
  {
    regex: /\b(today|tonight)\b/gi,
    kind: 'today',
    confidence: 1.0,
    resolve: (_m, now) => atMidnight(now),
  },
  {
    regex: /\byesterday\b/gi,
    kind: 'yesterday',
    confidence: 1.0,
    resolve: (_m, now) => addDays(now, -1),
  },
  {
    regex: new RegExp(`\\bnext\\s+${WD}\\b`, 'gi'),
    kind: 'next_weekday',
    confidence: 0.95,
    resolve: (m, now) => {
      const target = WEEKDAYS[m[1].toLowerCase()];
      if (target === undefined) return null;
      return addDays(now, daysToNextWeekday(now.getDay(), target));
    },
  },
  {
    regex: new RegExp(`\\b(?:this\\s+|on\\s+)?${WD}\\b`, 'gi'),
    kind: 'weekday',
    confidence: 0.85,
    resolve: (m, now) => {
      const target = WEEKDAYS[m[1].toLowerCase()];
      if (target === undefined) return null;
      return addDays(now, daysToUpcoming(now.getDay(), target));
    },
  },
  {
    regex: /\bnext\s+week\b/gi,
    kind: 'next_week',
    confidence: 0.9,
    // "next week" resolves to next Monday (start of next week)
    resolve: (_m, now) => addDays(now, ((8 - now.getDay()) % 7) || 7),
  },
  {
    regex: /\bnext\s+month\b/gi,
    kind: 'next_month',
    confidence: 0.9,
    resolve: (_m, now) => {
      const d = atMidnight(now);
      return new Date(d.getFullYear(), d.getMonth() + 1, 1);
    },
  },
  {
    regex: new RegExp(`\\bin\\s+${QTY}\\s+days?\\b`, 'gi'),
    kind: 'relative_days',
    confidence: 0.95,
    resolve: (m, now) => {
      const n = parseQuantity(m[1]);
      return n === null ? null : addDays(now, n);
    },
  },
  {
    regex: new RegExp(`\\b${QTY}\\s+days?\\s+(?:later|from\\s+now)\\b`, 'gi'),
    kind: 'relative_days',
    confidence: 0.9,
    resolve: (m, now) => {
      const n = parseQuantity(m[1]);
      return n === null ? null : addDays(now, n);
    },
  },
  {
    regex: new RegExp(`\\bin\\s+${QTY}\\s+weeks?\\b`, 'gi'),
    kind: 'relative_weeks',
    confidence: 0.95,
    resolve: (m, now) => {
      const n = parseQuantity(m[1]);
      return n === null ? null : addDays(now, n * 7);
    },
  },
  {
    regex: new RegExp(`\\b${QTY}\\s+weeks?\\s+(?:later|from\\s+now)\\b`, 'gi'),
    kind: 'relative_weeks',
    confidence: 0.9,
    resolve: (m, now) => {
      const n = parseQuantity(m[1]);
      return n === null ? null : addDays(now, n * 7);
    },
  },
  {
    regex: new RegExp(`\\bin\\s+${QTY}\\s+months?\\b`, 'gi'),
    kind: 'relative_months',
    confidence: 0.9,
    resolve: (m, now) => {
      const n = parseQuantity(m[1]);
      if (n === null) return null;
      const d = atMidnight(now);
      return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Extract ALL English date expressions from a text.
 * Overlapping matches are resolved by first-come (patterns are ordered
 * from most-specific to least-specific).
 *
 * @param text - Input text (any case)
 * @param now - Reference "now" (defaults to current time)
 */
export function extractEnglishDates(text: string, now: Date = new Date()): ParsedEnDate[] {
  const results: ParsedEnDate[] = [];
  /** Ranges already claimed by a more specific pattern */
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  for (const pattern of EN_DATE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const date = pattern.resolve(m, now);
      if (!date) continue;
      claimed.push([start, end]);
      results.push({
        matched: m[0],
        index: start,
        date,
        isoDate: toIsoDate(date),
        kind: pattern.kind,
        confidence: pattern.confidence,
      });
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

/**
 * Parse the FIRST (highest-priority) English date expression.
 * Returns null when nothing matches.
 */
export function parseEnglishDate(text: string, now: Date = new Date()): ParsedEnDate | null {
  const all = extractEnglishDates(text, now);
  if (all.length === 0) return null;
  // Prefer the most confident match; tiebreak by earliest position
  return all.reduce((best, cur) =>
    cur.confidence > best.confidence + 1e-9 ? cur : best,
  );
}

/** Expose toIsoDate for tests */
export { toIsoDate };
