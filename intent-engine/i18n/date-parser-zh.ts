/**
 * Claw Task Service — date-parser-zh.ts (Phase 3 M5)
 *
 * Parses Chinese date expressions into concrete dates.
 * Symmetric counterpart to date-parser-en.ts for the i18n pipeline.
 *
 * Supported expressions:
 *   - 今天 / 明天 / 后天 / 大后天
 *   - 周一 .. 周日        (upcoming occurrence, never today)
 *   - 下周一 .. 下周日   (strictly next week's occurrence)
 *   - 本月15号 / 下个月3日 / 8月20日 / 12月5日
 *   - 上午9点 / 下午2点半 / 晚上8点 / 早上7:30
 *   - 30分钟后 / 2小时15分钟后 / 3周后 / 2个月后
 *   - 2026-07-30 (full ISO date)
 *
 * Design notes:
 *   - Date patterns and time-of-day patterns are kept in SEPARATE
 *     pattern lists so they don't conflict with each other.
 *     (e.g., "3月20日" vs "3点", or "今天下午3点" — without separation,
 *     time patterns can fire before date patterns and claim overlapping ranges.)
 *   - All patterns are ordered from most-specific to least-specific.
 *   - Pure function of (text, now) — pass `now` for deterministic tests.
 *   - Returns null / [] for unparseable input (no exceptions).
 */

// ─── Types ──────────────────────────────────────────────────────────

/** A single parsed Chinese date expression */
export interface ParsedZhDate {
  /** The exact matched substring */
  matched: string;
  /** Start index of the match in the input */
  index: number;
  /** Resolved date (local midnight of the target day) */
  date: Date;
  /** ISO date string (YYYY-MM-DD) for stable comparison */
  isoDate: string;
  /**
   * ISO datetime string (YYYY-MM-DDTHH:MM:SS) when a time-of-day
   * or relative-duration was also resolved; undefined when only the date
   * part is meaningful (e.g. "周五").
   */
  isoDateTime?: string;
  /** Expression kind */
  kind:
    | 'today'
    | 'tomorrow'
    | 'day_after_tomorrow'
    | 'day_after_day_after_tomorrow'
    | 'weekday'
    | 'next_weekday'
    | 'time_of_day'
    | 'relative_minutes'
    | 'relative_hours'
    | 'relative_days'
    | 'relative_weeks'
    | 'relative_months'
    | 'absolute_month_day'
    | 'iso_date';
  /** Parser confidence [0,1] */
  confidence: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Chinese weekday tokens → JS getDay() values (0=Sunday … 6=Saturday) */
const WEEKDAY_NUM: Record<string, number> = {
  '周日': 0, '星期日': 0,
  '周一': 1, '星期一': 1,
  '周二': 2, '星期二': 2,
  '周三': 3, '星期三': 3,
  '周四': 4, '星期四': 4,
  '周五': 5, '星期五': 5,
  '周六': 6, '星期六': 6,
  '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
};

/** Short weekday token pattern (single Chinese numeral) */
const SHORT_WD = '(日|一|二|三|四|五|六)';

/** Chinese weekday group (full forms) */
const WEEKDAY_GROUP = '(?:周日|星期日|周一|星期一|周二|星期二|周三|星期三|周四|星期四|周五|星期五|周六|星期六)';

/** Chinese numeral + Arabic digit quantity */
const CN_QTY = '(?:[零一二三四五六七八九十百]{1,3}|\\d+)';

// ─── Date Helpers ───────────────────────────────────────────────────

/** Local midnight of a given date */
function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Add calendar days (local midnight) */
function addDays(d: Date, days: number): Date {
  const base = atMidnight(d);
  base.setDate(base.getDate() + days);
  return base;
}

/** Add calendar months (preserves day-of-month, clamps if overflow) */
function addMonths(d: Date, months: number): Date {
  const base = atMidnight(d);
  base.setMonth(base.getMonth() + months);
  return base;
}

/** Format YYYY-MM-DD in local time */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format YYYY-MM-DDTHH:MM:SS in local time */
function toIsoDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
}

// ─── Chinese Numeral Parser ─────────────────────────────────────────

/** Map Chinese digit characters to numeric values */
const CN_NUM_MAP: Record<string, number> = {
  '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

/**
 * Parse a Chinese numeral string (0-99) or Arabic digits to a number.
 * Handles: "15", "十五", "一十五", "二十", "两", "二"
 */
function parseCnNum(s: string): number | null {
  const trimmed = s.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  let total = 0;
  let temp = 0;
  for (const ch of Array.from(trimmed)) {
    const v = CN_NUM_MAP[ch];
    if (v === undefined) return null;

    if (v === 10) {
      // 十: if temp is 0, set it to 10; otherwise multiply
      temp = temp === 0 ? 10 : temp * 10;
    } else {
      temp += v;
    }
  }
  total += temp;
  return total >= 0 ? total : null;
}

// ─── Weekday Helpers ─────────────────────────────────────────────────

/**
 * Days until the upcoming occurrence of a weekday (1-7 days ahead).
 * Bare weekday like "周五" → the next occurrence (never today).
 */
function daysToUpcoming(nowDow: number, target: number): number {
  let diff = (target - nowDow + 7) % 7;
  if (diff === 0) diff = 7;
  return diff;
}

/**
 * Days until the Monday of next week, then offset to target weekday.
 * "下周一" on a Monday = 7 days ahead.
 */
function daysToNextWeekday(nowDow: number, target: number): number {
  const daysToNextMonday = ((8 - nowDow) % 7) || 7;
  const offset = (target - 1 + 7) % 7; // Monday=0 … Sunday=6
  return daysToNextMonday + offset;
}

// ─── Pattern Table ──────────────────────────────────────────────────

interface ZhDatePattern {
  regex: RegExp;
  kind: ParsedZhDate['kind'];
  confidence: number;
  resolve: (
    m: RegExpExecArray,
    now: Date,
  ) => { date: Date; time?: { hours: number; minutes: number } } | null;
}

/**
 * DATE patterns — ordered from most-specific to least-specific.
 * These patterns produce a DATE result only (isoDate, no isoDateTime).
 *
 * IMPORTANT: These patterns must be placed BEFORE any time patterns so
 * they get first chance to claim overlapping ranges.
 */
const ZH_DATE_PATTERNS: ZhDatePattern[] = [

  // ── 1. ISO full date: 2026-07-30 ──────────────────────────────
  {
    regex: /(?<![0-9a-zA-Z])(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})[日号]?(?![0-9a-zA-Z])/gu,
    kind: 'iso_date',
    confidence: 1.0,
    resolve: (m) => {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10) - 1;
      const d = parseInt(m[3], 10);
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      return { date: new Date(y, mo, d) };
    },
  },

  // ── 2. 本月15号 ───────────────────────────────────────────────
  {
    regex: /本月(\d{1,2})[号日]/gu,
    kind: 'absolute_month_day',
    confidence: 0.95,
    resolve: (m, now) => {
      const day = parseInt(m[1], 10);
      if (day < 1 || day > 31) return null;
      return { date: new Date(now.getFullYear(), now.getMonth(), day) };
    },
  },

  // ── 3. 下个月3日 / 下月15号 ──────────────────────────────────
  {
    regex: /下个月?(\d{1,2})(?:[号日])?/gu,
    kind: 'absolute_month_day',
    confidence: 0.95,
    resolve: (m, now) => {
      const day = parseInt(m[1], 10);
      if (day < 1 || day > 31) return null;
      const base = atMidnight(now);
      base.setMonth(base.getMonth() + 1);
      base.setDate(day);
      return { date: base };
    },
  },

  // ── 4. 8月20日 / 12月5日 / 8月20号 ─────────────────────────
  // The negative lookaheads prevent matching when the day number is
  // actually part of a time expression (e.g. "下午3点" where "3" is hour).
  {
    regex: /(?<![0-9a-zA-Z月])(\d{1,2})月(\d{1,2})(?:[号日])?(?![0-9a-zA-Z日号点和分:：半秒])/gu,
    kind: 'absolute_month_day',
    confidence: 0.9,
    resolve: (m, now) => {
      const mo = parseInt(m[1], 10) - 1;
      const d = parseInt(m[2], 10);
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      return { date: new Date(now.getFullYear(), mo, d) };
    },
  },

  // ── 5. 下周日 / 下周六 (short form: 下周一, 下周二, etc.) ───
  {
    regex: new RegExp(`下周(${SHORT_WD})`, 'gu'),
    kind: 'next_weekday',
    confidence: 0.95,
    resolve: (m, now) => {
      const target = WEEKDAY_NUM['周' + m[1]];
      if (target === undefined) return null;
      return { date: addDays(now, daysToNextWeekday(now.getDay(), target)) };
    },
  },

  // ── 6. 下周一 .. 下周日 (full forms) ──────────────────────────
  {
    regex: new RegExp(`下(${WEEKDAY_GROUP})`, 'gu'),
    kind: 'next_weekday',
    confidence: 0.95,
    resolve: (m, now) => {
      const target = WEEKDAY_NUM[m[1]];
      if (target === undefined) return null;
      return { date: addDays(now, daysToNextWeekday(now.getDay(), target)) };
    },
  },

  // ── 7. 本周周三 / 这周四 (本周/这周 + weekday) ─────────────
  {
    regex: new RegExp(`(本周|这周)周([一二三四五六日])`, 'gu'),
    kind: 'weekday',
    confidence: 0.9,
    resolve: (m, now) => {
      const target = WEEKDAY_NUM['周' + m[2]];
      if (target === undefined) return null;
      return { date: addDays(now, daysToUpcoming(now.getDay(), target)) };
    },
  },

  // ── 8. 星期日 .. 星期六 (星期-prefixed weekdays) ─────────────
  {
    regex: new RegExp(WEEKDAY_GROUP, 'gu'),
    kind: 'weekday',
    confidence: 0.88,
    resolve: (m, now) => {
      const target = WEEKDAY_NUM[m[0]];
      if (target === undefined) return null;
      return { date: addDays(now, daysToUpcoming(now.getDay(), target)) };
    },
  },

  // ── 9. 周一 .. 周日 (standalone bare weekday at text start) ──
  // Do NOT use ^ anchor with the u flag — it causes infinite matches in V8.
  // Instead use a global pattern and check m.index === 0 in the resolve function.
  {
    regex: new RegExp(`周([一二三四五六日])`, 'gu'),
    kind: 'weekday',
    confidence: 0.85,
    resolve: (m, now) => {
      // Only accept if this is the first character in the string
      if (m.index !== 0) return null;
      const full = '周' + m[1];
      const target = WEEKDAY_NUM[full];
      if (target === undefined) return null;
      return { date: addDays(now, daysToUpcoming(now.getDay(), target)) };
    },
  },

  // ── 10. N分钟后 / N分后 / N秒后 ────────────────────────────
  {
    regex: new RegExp(`^(${CN_QTY})\\s*(?:分|分钟|秒|秒钟)(?:后)?`, 'u'),
    kind: 'relative_minutes',
    confidence: 0.95,
    resolve: (m, now) => {
      const n = parseCnNum(m[1]);
      if (n === null || n < 0) return null;
      const d = new Date(now.getTime() + n * 60 * 1000);
      return { date: atMidnight(d), time: { hours: d.getHours(), minutes: d.getMinutes() } };
    },
  },

  // ── 11. N小时后 / N小时N分钟后 ──────────────────────────────
  {
    regex: new RegExp(`^(${CN_QTY})\\s*(?:小时|钟头)(?:(${CN_QTY})\\s*(?:分|分钟)(?:后)?)?(?:后)?`, 'u'),
    kind: 'relative_hours',
    confidence: 0.95,
    resolve: (m, now) => {
      const h = parseCnNum(m[1]);
      if (h === null || h < 0) return null;
      const extraMin = m[2] ? parseCnNum(m[2]) : 0;
      if (extraMin === null || extraMin < 0) return null;
      const ms = (h * 60 + extraMin) * 60 * 1000;
      const d = new Date(now.getTime() + ms);
      return { date: atMidnight(d), time: { hours: d.getHours(), minutes: d.getMinutes() } };
    },
  },

  // ── 12. N天后 / N天后再 ───────────────────────────────────
  {
    regex: new RegExp(`^(${CN_QTY})\\s*(?:天|日后|天后)(?:后|再)?`, 'u'),
    kind: 'relative_days',
    confidence: 0.95,
    resolve: (m, now) => {
      const n = parseCnNum(m[1]);
      if (n === null || n < 0) return null;
      return { date: addDays(now, n) };
    },
  },

  // ── 13. N周后 / N个星期后 ─────────────────────────────────
  {
    regex: new RegExp(`^(${CN_QTY})\\s*(?:周|个?星期)(?:后)?`, 'u'),
    kind: 'relative_weeks',
    confidence: 0.9,
    resolve: (m, now) => {
      const n = parseCnNum(m[1]);
      if (n === null || n < 0) return null;
      return { date: addDays(now, n * 7) };
    },
  },

  // ── 14. N个月后 / N月后 ───────────────────────────────────
  {
    regex: new RegExp(`^(${CN_QTY})\\s*(?:个月?|月)(?:后)?`, 'u'),
    kind: 'relative_months',
    confidence: 0.9,
    resolve: (m, now) => {
      const n = parseCnNum(m[1]);
      if (n === null || n < 0) return null;
      return { date: addMonths(now, n) };
    },
  },

  // ── 15. 大后天 ────────────────────────────────────────────
  {
    regex: /大后天/g,
    kind: 'day_after_day_after_tomorrow',
    confidence: 1.0,
    resolve: (_m, now) => ({ date: addDays(now, 3) }),
  },

  // ── 16. 后天 ──────────────────────────────────────────────
  {
    regex: /后天/g,
    kind: 'day_after_tomorrow',
    confidence: 1.0,
    resolve: (_m, now) => ({ date: addDays(now, 2) }),
  },

  // ── 17. 明天 ──────────────────────────────────────────────
  {
    regex: /明天/g,
    kind: 'tomorrow',
    confidence: 1.0,
    resolve: (_m, now) => ({ date: addDays(now, 1) }),
  },

  // ── 18. 今天 ─────────────────────────────────────────────
  {
    regex: /今天/g,
    kind: 'today',
    confidence: 1.0,
    resolve: (_m, now) => ({ date: atMidnight(now) }),
  },
];

/**
 * TIME patterns — processed AFTER date patterns.
 * These produce a time-of-day result (isoDateTime set, date at local midnight).
 *
 * By running time patterns in a separate pass AFTER dates, we avoid
 * conflicts like "3月20日" (month-day) vs "3点" (time-of-day hour).
 */
interface ZhTimePattern {
  regex: RegExp;
  kind: 'time_of_day';
  confidence: number;
  resolve: (
    m: RegExpExecArray,
    now: Date,
  ) => { hours: number; minutes: number } | null;
}

const ZH_TIME_PATTERNS: ZhTimePattern[] = [

  // ── Time: 上午9点半 / 下午2点半 / 晚上8:30 ─────────────────
  // m[1] = prefix (上午/下午/早上/晚上/中午)
  // m[2] = hour
  // m[3] = '半' or numeric minutes
  {
    regex: /(上午|下午|早上|晚上|中午)[^\u4e00-\u9fff]{0,8}?(\d{1,2})[点时:：]((?:半)|(\d{1,2}))/gu,
    kind: 'time_of_day',
    confidence: 0.95,
    resolve: (m, now) => {
      let h = parseInt(m[2], 10);
      const mm = m[3] === '半' ? 30 : parseInt(m[4] ?? '0', 10);
      const prefix = m[1];
      if (prefix === '下午' || prefix === '晚上') {
        if (h < 12) h += 12;
      } else if (prefix === '中午' && h < 12) {
        h = h < 11 ? 12 : h;
      }
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      return { hours: h, minutes: mm };
    },
  },

  // ── Time: 9点半 / 14:30 / 2点半 / 9:30 ────────────────────
  // Negative lookbehind prevents matching when already inside a
  // compound hour-minute token (e.g. "点半" or "分30秒").
  {
    regex: /(?<![点半分秒:：])(\d{1,2})[点时:：]((?:半)|(\d{1,2}))/gu,
    kind: 'time_of_day',
    confidence: 0.8,
    resolve: (m, now) => {
      const h = parseInt(m[1], 10);
      const mm = m[2] === '半' ? 30 : parseInt(m[3] ?? '0', 10);
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      return { hours: h, minutes: mm };
    },
  },

  // ── Time: 9点 / 9时 (no minutes) ──────────────────────────
  {
    regex: /(?<![点半分秒:：])(\d{1,2})[点时]$/gu,
    kind: 'time_of_day',
    confidence: 0.75,
    resolve: (m, now) => {
      const h = parseInt(m[1], 10);
      if (h < 0 || h > 23) return null;
      return { hours: h, minutes: 0 };
    },
  },
];

// ─── Internal Assembly ──────────────────────────────────────────────

function buildDateResult(
  matched: string,
  index: number,
  result: { date: Date; time?: { hours: number; minutes: number } },
  kind: ParsedZhDate['kind'],
  confidence: number,
): ParsedZhDate {
  const { date, time } = result;
  const out: ParsedZhDate = {
    matched,
    index,
    date,
    isoDate: toIsoDate(date),
    kind,
    confidence,
  };
  if (time) {
    const withTime = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      time.hours,
      time.minutes,
    );
    out.isoDateTime = toIsoDateTime(withTime);
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Extract ALL Chinese date expressions from a text.
 * Order of processing:
 *   1. Date patterns (today, weekdays, relative durations, month-day, ISO)
 *   2. Time patterns (上午/下午 + time, bare time)
 *
 * Overlapping date vs time patterns are resolved by first-come:
 *   - If a time pattern fires first, it claims its range
 *   - But since we run dates first, date expressions get priority
 *
 * @param text - Input text
 * @param now  - Reference "now" (defaults to current time)
 */
export function extractChineseDates(
  text: string,
  now: Date = new Date(),
): ParsedZhDate[] {
  const results: ParsedZhDate[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  // ── Phase 1: Date patterns ─────────────────────────────────
  for (const pattern of ZH_DATE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const result = pattern.resolve(m, now);
      if (!result) continue;
      claimed.push([start, end]);
      results.push(
        buildDateResult(m[0], start, result, pattern.kind, pattern.confidence),
      );
    }
  }

  // ── Phase 2: Time patterns ────────────────────────────────
  for (const pattern of ZH_TIME_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      const result = pattern.resolve(m, now);
      if (!result) continue;
      claimed.push([start, end]);
      // Time patterns: date = today midnight, time = parsed hours+minutes
      const date = atMidnight(now);
      const withTime = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        result.hours,
        result.minutes,
      );
      results.push({
        matched: m[0],
        index: start,
        date,
        isoDate: toIsoDate(date),
        isoDateTime: toIsoDateTime(withTime),
        kind: pattern.kind,
        confidence: pattern.confidence,
      });
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

/**
 * Parse the FIRST (highest-priority) Chinese date expression.
 * Returns null when nothing matches.
 */
export function parseChineseDate(
  text: string,
  now: Date = new Date(),
): ParsedZhDate | null {
  const all = extractChineseDates(text, now);
  if (all.length === 0) return null;
  return all.reduce(
    (best, cur) => (cur.confidence > best.confidence + 1e-9 ? cur : best),
  );
}
