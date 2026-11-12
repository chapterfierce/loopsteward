import { LoopStore } from './loop-store.js';
import type {
  LoopFeedbackRecord,
  LoopFeedbackVerdict,
  LoopRecord,
} from './types.js';

export interface RecordLoopFeedbackInput {
  id?: string;
  ref?: string;
  match?: string;
  index?: number;
  projectDir?: string;
  verdict: LoopFeedbackVerdict;
  note?: string;
  at?: string;
}

export interface RecordLoopFeedbackBatchInput {
  refs: string[];
  verdict: LoopFeedbackVerdict;
  note?: string;
  at?: string;
}

export type RecordLoopFeedbackResult =
  | { status: 'recorded'; loop: LoopRecord; feedback: LoopFeedbackRecord }
  | { status: 'not_found'; message: string }
  | { status: 'ambiguous'; message: string; matches: LoopRecord[] };

export type RecordLoopFeedbackBatchResult =
  | { status: 'recorded'; loops: LoopRecord[]; feedback: LoopFeedbackRecord[] }
  | { status: 'not_found'; message: string; ref?: string }
  | { status: 'ambiguous'; message: string; ref: string; matches: LoopRecord[] };

export function isNoiseSuppressed(
  loop: Pick<LoopRecord, 'lastSeen'>,
  feedback?: LoopFeedbackRecord,
): boolean {
  if (feedback?.verdict !== 'noise') return false;
  const loopMs = Date.parse(loop.lastSeen);
  const feedbackMs = Date.parse(feedback.createdAt);
  return Number.isFinite(loopMs)
    && Number.isFinite(feedbackMs)
    && loopMs <= feedbackMs;
}

type ResolveLoopTargetResult =
  | { status: 'found'; loop: LoopRecord }
  | { status: 'not_found'; message: string }
  | { status: 'ambiguous'; message: string; matches: LoopRecord[] };

type ResolveLoopRefsResult =
  | { status: 'found'; loops: LoopRecord[] }
  | { status: 'not_found'; message: string; ref: string }
  | { status: 'ambiguous'; message: string; ref: string; matches: LoopRecord[] };

function resolveLoopRefs(store: LoopStore, refs: string[]): ResolveLoopRefsResult {
  const seen = new Set<string>();
  const loops: LoopRecord[] = [];
  for (const ref of refs) {
    const matches = store.findLoopsByRef(ref);
    if (matches.length === 0) {
      return { status: 'not_found', message: `no loop matches ref: ${ref}`, ref };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        message: `ambiguous ref: ${ref}`,
        ref,
        matches,
      };
    }
    const loop = matches[0];
    if (seen.has(loop.id)) continue;
    seen.add(loop.id);
    loops.push(loop);
  }
  return { status: 'found', loops };
}

function resolveLoopTarget(
  store: LoopStore,
  input: RecordLoopFeedbackInput,
): ResolveLoopTargetResult {
  const provided = [input.id, input.ref, input.match, input.index].filter(
    (value) => value !== undefined,
  ).length;
  if (provided !== 1) {
    throw new Error('use exactly one of --id, --ref, --match, or --index');
  }

  if (input.index !== undefined) {
    const resolved = store.resolvePresentationIndex(input.index);
    if (resolved.status !== 'found') {
      return { status: 'not_found', message: resolved.message };
    }
    const loop = store.getLoop(resolved.loopId);
    return loop
      ? { status: 'found', loop }
      : { status: 'not_found', message: `loop not found: ${resolved.loopId}` };
  }

  if (input.id) {
    const loop = store.getLoop(input.id);
    return loop
      ? { status: 'found', loop }
      : { status: 'not_found', message: `loop not found: ${input.id}` };
  }

  if (input.ref) {
    const matches = store.findLoopsByRef(input.ref);
    if (matches.length === 0) {
      return { status: 'not_found', message: `no loop matches ref: ${input.ref}` };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        message: `ambiguous ref: ${input.ref}`,
        matches,
      };
    }
    return { status: 'found', loop: matches[0] };
  }

  const matches = store.findLoopsByText(input.match!, {
    projectDir: input.projectDir,
  });
  if (matches.length === 0) {
    return { status: 'not_found', message: `no active loop matches: ${input.match}` };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      message: `ambiguous match: ${input.match}`,
      matches,
    };
  }
  return { status: 'found', loop: matches[0] };
}

export function recordLoopFeedback(
  store: LoopStore,
  input: RecordLoopFeedbackInput,
): RecordLoopFeedbackResult {
  const initial = resolveLoopTarget(store, input);
  if (initial.status !== 'found') return initial;

  return store.runInWriteTransaction(() => {
    const current = resolveLoopTarget(store, input);
    if (current.status !== 'found') return current;

    const feedback = store.recordFeedback(current.loop.id, input.verdict, input.note, input.at);
    if (!feedback) {
      return { status: 'not_found', message: `loop not found: ${current.loop.id}` };
    }
    return { status: 'recorded', loop: current.loop, feedback };
  });
}

export function recordLoopFeedbackBatch(
  store: LoopStore,
  input: RecordLoopFeedbackBatchInput,
): RecordLoopFeedbackBatchResult {
  const initial = resolveLoopRefs(store, input.refs);
  if (initial.status !== 'found') return initial;

  return store.runInWriteTransaction(() => {
    const current = resolveLoopRefs(store, input.refs);
    if (current.status !== 'found') return current;

    const feedback: LoopFeedbackRecord[] = [];
    for (const loop of current.loops) {
      const recorded = store.recordFeedback(loop.id, input.verdict, input.note, input.at);
      if (!recorded) {
        throw new Error(`loop not found: ${loop.id}`);
      }
      feedback.push(recorded);
    }
    return { status: 'recorded', loops: current.loops, feedback };
  });
}
