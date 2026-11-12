const LOOP_ID_RE = /^loop_([0-9a-f]{16})$/i;
const REF_RE = /^(?:loop_)?([0-9a-f]{4,16})$/i;

export const LOOP_REF_LENGTH = 8;

export function loopRef(loopId: string): string {
  const match = LOOP_ID_RE.exec(loopId.trim());
  if (match) return match[1].slice(0, LOOP_REF_LENGTH).toLowerCase();
  return loopId.replace(/^loop_/i, '').slice(0, LOOP_REF_LENGTH).toLowerCase();
}

export function normalizeLoopRef(input: string): string | undefined {
  const value = input.trim().replace(/^#/, '');
  const match = REF_RE.exec(value);
  return match ? match[1].toLowerCase() : undefined;
}
