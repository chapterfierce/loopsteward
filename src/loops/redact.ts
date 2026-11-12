const REDACTED = '[REDACTED]';

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi;
const OPENAI_KEY = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ASSIGNMENT = /(\b(?:api[_-]?key|apikey|password|passwd|secret|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\b\s*[:=]\s*)(['"]?)([^\s'",;]{6,})\2/gi;
const CLI_SECRET = /(\B--(?:api[_-]?key|token|password)\s+)(\S{8,})/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(OPENAI_KEY, 'sk-[REDACTED]')
    .replace(GITHUB_TOKEN, (match) => `${match.slice(0, match.indexOf('_') + 1)}[REDACTED]`)
    .replace(SLACK_TOKEN, (match) => `${match.slice(0, match.indexOf('-') + 1)}[REDACTED]`)
    .replace(AWS_ACCESS_KEY, 'AKIA[REDACTED]')
    .replace(JWT, '[REDACTED JWT]')
    .replace(ASSIGNMENT, `$1$2${REDACTED}$2`)
    .replace(CLI_SECRET, `$1${REDACTED}`);
}

export function containsSecretLikeText(text: string): boolean {
  if (!text) return false;
  const patterns = [
    PRIVATE_KEY,
    URL_CREDENTIALS,
    BEARER,
    OPENAI_KEY,
    GITHUB_TOKEN,
    SLACK_TOKEN,
    AWS_ACCESS_KEY,
    JWT,
    ASSIGNMENT,
    CLI_SECRET,
  ];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
