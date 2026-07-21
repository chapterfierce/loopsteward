/**
 * Claw Task Service — Text Preprocessor (Phase 2.5)
 *
 * Normalizes user input before classification:
 *  - Full-width → half-width conversion
 *  - Case normalization (lowercase)
 *  - Whitespace normalization
 *  - Common abbreviation expansion
 *  - Punctuation stripping
 *  - Time expression detection
 */

/** Preprocessing result with both processed text and metadata */
export interface PreprocessResult {
  /** The normalized text for classification */
  normalized: string;
  /** The original input text (preserved) */
  original: string;
  /** Number of tokens after tokenization */
  tokenCount: number;
  /** Individual tokens */
  tokens: string[];
  /** Abbreviations that were expanded */
  expansions: string[];
  /** Detected time expressions */
  timeExpressions: string[];
}

// ─── Character Mapping ─────────────────────────────────────────────

/**
 * Full-width to half-width character mappings.
 * Covers digits, letters, punctuation, and common CJK punctuation.
 */
const FULL_TO_HALF: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e',
  'ｆ': 'f', 'ｇ': 'g', 'ｈ': 'h', 'ｉ': 'i', 'ｊ': 'j',
  'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n', 'ｏ': 'o',
  'ｐ': 'p', 'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't',
  'ｕ': 'u', 'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x', 'ｙ': 'y',
  'ｚ': 'z',
  'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E',
  'Ｆ': 'F', 'Ｇ': 'G', 'Ｈ': 'H', 'Ｉ': 'I', 'Ｊ': 'J',
  'Ｋ': 'K', 'Ｌ': 'L', 'Ｍ': 'M', 'Ｎ': 'N', 'Ｏ': 'O',
  'Ｐ': 'P', 'Ｑ': 'Q', 'Ｒ': 'R', 'Ｓ': 'S', 'Ｔ': 'T',
  'Ｕ': 'U', 'Ｖ': 'V', 'Ｗ': 'W', 'Ｘ': 'X', 'Ｙ': 'Y',
  'Ｚ': 'Z',
  '！': '!', '＂': '"', '＃': '#', '＄': '$', '％': '%',
  '＆': '&', '＇': "'", '（': '(', '）': ')', '＊': '*',
  '＋': '+', '，': ',', '－': '-', '．': '.', '／': '/',
  '：': ':', '；': ';', '＜': '<', '＝': '=', '＞': '>',
  '？': '?', '＠': '@', '［': '[', '＼': '\\', '］': ']',
  '＾': '^', '＿': '_', '｀': '`', '｛': '{', '｜': '|',
  '｝': '}', '～': '~', '　': ' ',
  // CJK punctuation
  '。': '.', '，': ',', '！': '!', '？': '?', '；': ';',
  '：': ':', '、': ',', '【': '[', '】': ']', '《': '<',
  '》': '>', '（': '(', '）': ')', '「': '"', '」': '"',
  '『': "'", '』': "'",
};

// ─── Abbreviation Expansion ─────────────────────────────────────────

const ABBREVIATIONS: Record<string, string> = {
  'ddl': 'deadline',
  'dl': 'deadline',
  'td': 'todo',
  'todo': 'todo',
  'qa': 'quality assurance',
  'cr': 'code review',
  'pr': 'pull request',
  'wip': 'work in progress',
};

// ─── Time Expression Patterns ───────────────────────────────────────

const TIME_PATTERNS = [
  /(本周|下周|上周|这周)/,
  /(周一|周二|周三|周四|周五|周六|周日|星期一|星期二|星期三|星期四|星期五|星期六|星期日)/,
  /(\d{1,2}[点时]\d{0,2}分?)/,
  /(\d{1,2}[月日号])/,
  /(上午|下午|晚上|早上|中午)/,
  /(今天|明天|后天|昨天|前天)/,
];

// ─── Punctuation / Stop Characters ──────────────────────────────────

const STOP_CHARS = /[,.!?;:()\[\]{}"'<>/\\|`~@#$%^&*+=_—–…·\s]+/g;

// ─── Core Pipeline ──────────────────────────────────────────────────

/**
 * Convert full-width characters to half-width.
 */
function fullToHalf(text: string): string {
  let result = '';
  for (const ch of text) {
    result += FULL_TO_HALF[ch] ?? ch;
  }
  return result;
}

/**
 * Expand common abbreviations.
 * Returns both the expanded text and a list of expansions performed.
 */
function expandAbbreviations(text: string): { text: string; expansions: string[] } {
  const expansions: string[] = [];
  const lower = text.toLowerCase();

  for (const [abbr, expansion] of Object.entries(ABBREVIATIONS)) {
    // Match as whole word or with surrounding whitespace
    const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
    if (regex.test(lower)) {
      expansions.push(`${abbr} → ${expansion}`);
    }
  }

  // We don't actually replace abbreviations in text (they're useful signals)
  // but we record them for metrics
  return { text, expansions };
}

/**
 * Detect time expressions in text.
 */
function detectTimeExpressions(text: string): string[] {
  const expressions: string[] = [];
  for (const pattern of TIME_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      expressions.push(match[0]);
    }
  }
  return expressions;
}

/**
 * Tokenize text into words/tokens.
 * Handles Chinese (character-level) and English (word-level) properly.
 */
function tokenize(text: string): string[] {
  // Split on whitespace and punctuation
  const raw = text.replace(STOP_CHARS, ' ').trim();
  if (!raw) return [];

  // Split into tokens, preserving multi-character Chinese words
  // by keeping consecutive word characters together
  const tokens: string[] = [];
  for (const part of raw.split(/\s+/)) {
    if (!part) continue;
    // If mostly CJK, split by character
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(part)) {
      // Try to keep common multi-char phrases together
      tokens.push(...segmentCJK(part));
    } else {
      tokens.push(part.toLowerCase());
    }
  }

  return tokens.filter(t => t.length > 0);
}

/**
 * Simple CJK segmentation: keep bigrams as tokens but also emit unigrams.
 * This helps match both single-char and multi-char keywords.
 */
function segmentCJK(text: string): string[] {
  const result: string[] = [];
  // Emit individual characters
  for (const ch of text) {
    result.push(ch);
  }
  // Emit bigrams for compound matching
  for (let i = 0; i < text.length - 1; i++) {
    result.push(text.substring(i, i + 2));
  }
  // Emit trigrams for longer phrases
  for (let i = 0; i < text.length - 2; i++) {
    result.push(text.substring(i, i + 3));
  }
  return result;
}

/**
 * Main preprocessing pipeline.
 *
 * Steps:
 * 1. Trim whitespace
 * 2. Convert full-width to half-width
 * 3. Lowercase
 * 4. Expand abbreviations (recorded, not replaced)
 * 5. Detect time expressions
 * 6. Normalize whitespace
 * 7. Tokenize
 */
export function preprocess(text: string): PreprocessResult {
  // Step 1: Trim
  let processed = text.trim();

  // Step 2: Full-width → half-width
  processed = fullToHalf(processed);

  // Step 3: Lowercase (preserves original separately)
  processed = processed.toLowerCase();

  // Step 4: Expand abbreviations
  const { expansions } = expandAbbreviations(processed);

  // Step 5: Detect time expressions
  const timeExpressions = detectTimeExpressions(processed);

  // Step 6: Normalize whitespace (collapse multiple spaces)
  processed = processed.replace(/\s+/g, ' ').trim();

  // Step 7: Tokenize
  const tokens = tokenize(processed);

  return {
    normalized: processed,
    original: text,
    tokenCount: tokens.length,
    tokens,
    expansions,
    timeExpressions,
  };
}

/**
 * Quick tokenize without full preprocessing (for internal use).
 */
export function quickTokenize(text: string): string[] {
  return tokenize(fullToHalf(text).toLowerCase());
}
