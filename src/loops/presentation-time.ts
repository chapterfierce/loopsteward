const MINUTE_MS = 60 * 1000;

export const PRESENTATION_FUTURE_TOLERANCE_MS = 5 * MINUTE_MS;

export function presentationFutureCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() + PRESENTATION_FUTURE_TOLERANCE_MS).toISOString();
}

export function isPresentationInFuture(presentedMs: number, nowMs: number): boolean {
  return Number.isFinite(presentedMs)
    && presentedMs - nowMs > PRESENTATION_FUTURE_TOLERANCE_MS;
}
