export type LoopStatus = 'open' | 'pending' | 'snoozed' | 'resolved' | 'dropped';

export type LoopOrigin = 'user' | 'assistant' | 'mixed';

export type SessionAgent = 'codex' | 'claude' | 'qoder-cn' | 'zcode' | 'workbuddy' | 'hermes' | 'dsh' | 'agy';

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface RecentSession {
  agent: SessionAgent;
  sessionId: string;
  title: string;
  projectDir: string;
  lastActive: string;
  messages: SessionMessage[];
  /**
   * Older messages kept for evidence retrieval. `messages` stays the short
   * tail used by extraction; reconcile may search this window for status
   * updates that scrolled out of the tail.
   */
  history?: SessionMessage[];
  sourceFile: string;
}

export interface LoopSignal {
  id: string;
  source: 'session';
  sourceId: string;
  messageId: string;
  agent: SessionAgent;
  role: 'user' | 'assistant';
  text: string;
  projectDir: string;
  capturedAt: string;
  capturedAtSource?: 'message' | 'session';
  contentHash: string;
  processedAt?: string;
}

export interface ExtractedLoop {
  title: string;
  nextAction: string;
  why: string;
  confidence: number;
  sourceMessageIds: string[];
  mergeInto?: string;
}

export interface LoopCandidate {
  title: string;
  nextAction: string;
  why: string;
  confidence: number;
  sourceSignalIds: string[];
  mergeInto?: string;
}

export interface ResolvedLoop {
  loopId: string;
  confidence: number;
  reason: string;
  evidenceMessageIds: string[];
}

export interface ResolutionCandidate extends ResolvedLoop {
  ref: string;
  title: string;
  projectDir: string;
  projectName: string;
  agent: SessionAgent;
  sessionId: string;
}

export interface ReconcileCacheCandidate extends ResolvedLoop {
  checkedAt: string;
  sessionKey: string;
  title: string;
  projectDir: string;
  projectName: string;
}

export interface ReconcileSummary {
  sessionsSeen: number;
  sessionsChecked: number;
  sessionsCached: number;
  cachePruned: number;
  candidates: ResolutionCandidate[];
  applied: string[];
  errors: string[];
}

export interface IngestRunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  source: string;
  signalsSeen: number;
  loopsCreated: number;
  loopsMerged: number;
  errors: string[];
}

export interface LoopStatsProject {
  projectDir: string;
  projectName: string;
  lastActive: string;
  sessionOnly: boolean;
  open: number;
  pending: number;
  resolved: number;
  dropped: number;
}

export type LoopFeedbackVerdict = 'forgotten' | 'noise';

export interface LoopFeedbackRecord {
  id: string;
  loopId: string;
  verdict: LoopFeedbackVerdict;
  note?: string;
  createdAt: string;
}

export interface LoopFeedbackCounts {
  forgotten: number;
  noise: number;
}

export type LoopPresentationKind = 'hot' | 'review' | 'recap' | 'teaser' | 'candidate';

export interface LoopPresentation {
  id: number;
  presentedAt: string;
  mode: 'hot' | 'review';
  kind: LoopPresentationKind;
  loopIds: string[];
}

export interface LoopPresentationStats {
  loopId: string;
  count: number;
  firstPresentedAt: string;
  lastPresentedAt: string;
}

export interface LoopStats {
  generatedAt: string;
  windowDays: number;
  totals: {
    all: number;
    open: number;
    pending: number;
    snoozed: number;
    resolved: number;
    dropped: number;
    origins: {
      user: number;
      assistant: number;
      mixed: number;
    };
  };
  resolution: {
    resolvedInWindow: number;
    closureRate: number | null;
    resolutionRate: number | null;
    selfGeneratedDropped: number;
    medianResolutionHours: number | null;
  };
  surfacing: {
    surfaced: number;
    presented: number;
    neverPresented: number;
    neverSurfaced: number;
    resolvedAfterSurface: number;
    resolvedAfterPresentation: number;
    repeated: number;
    firstPresentedInWindow: number;
    resolvedAfterPresentationInWindow: number;
    medianHoursToFirstPresentation: number | null;
    futurePresentations: number;
    presentationsByKind: Record<LoopPresentationKind, number>;
  };
  feedback: LoopFeedbackCounts & {
    usefulRate: number | null;
    forgottenInWindow: number;
    noiseInWindow: number;
    usefulRateInWindow: number | null;
  };
  staleOpen: Array<{
    id: string;
    title: string;
    projectName: string;
    lastSeen: string;
    daysStale: number;
  }>;
  projects: LoopStatsProject[];
  projectSummary: {
    real: number;
    sessionOnly: number;
    sessionOnlyOpen: number;
    sessionOnlyPending: number;
  };
  lastIngest?: IngestRunRecord;
}

export interface LoopRecord {
  id: string;
  title: string;
  nextAction: string;
  why: string;
  status: LoopStatus;
  origin?: LoopOrigin;
  confidence: number;
  projectDir: string;
  projectName: string;
  sourceSignalIds: string[];
  firstSeen: string;
  lastSeen: string;
  lastSurfacedAt?: string;
  hotSurfacedAt?: string;
  ignoredCount: number;
  presentationCount?: number;
  lastPresentedAt?: string;
  snoozeUntil?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface IngestSummary {
  sessionsSeen: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  signalsSeen: number;
  loopsCreated: number;
  loopsMerged: number;
  errors: string[];
}

export interface RedactionSummary {
  applied: boolean;
  signalsScanned: number;
  signalsChanged: number;
  loopsScanned: number;
  loopsChanged: number;
  samples: string[];
}

export interface LoopListFilter {
  status?: LoopStatus;
  projectDir?: string;
  limit?: number;
  includeAll?: boolean;
}

export interface ProjectActivity {
  projectDir: string;
  projectName: string;
  lastActive: string;
  sessionCount: number;
  lastSessionId?: string;
}

export interface ProjectSummary {
  projectDir: string;
  projectName: string;
  lastActive: string;
  sessionCount: number;
  open: number;
  pending: number;
  snoozed: number;
  total: number;
  sessionOnly: boolean;
}

export interface DigestGroup {
  projectDir: string;
  projectName: string;
  lastActive: string;
  loops: LoopRecord[];
}

export interface DigestFocusProject {
  dir: string;
  name: string;
  matched: boolean;
  shown: number;
  backlog: number;
  userBacklog?: number;
  assistantBacklog?: number;
}

export interface DigestResult {
  mode: 'hot' | 'review';
  generatedAt: string;
  groups: DigestGroup[];
  reviewPick?: LoopRecord;
  focusProject?: DigestFocusProject;
  focusNextLoop?: LoopRecord;
  focusCompletionCandidate?: ReconcileCacheCandidate;
  reviewDue?: boolean;
  reviewRemaining?: number;
  reviewRemainingSessionOnly?: number;
  pendingTotal?: number;
  closeCandidates?: ReconcileCacheCandidate[];
  recap: LoopRecord[];
  recapConfirmedIds: string[];
  reviewConfirmed: LoopRecord[];
  recapThrottled?: boolean;
  recapFocusEmpty?: boolean;
  closingTotal?: number;
  focusClosingTotal?: number;
  closingCompletionTotal?: number;
  focusClosingCompletionTotal?: number;
  closingCompletionOrigins?: {
    user: number;
    assistant: number;
    mixed: number;
  };
  focusClosingCompletionOrigins?: {
    user: number;
    assistant: number;
    mixed: number;
  };
  closingOrigins: {
    user: number;
    assistant: number;
    mixed: number;
  };
  focusClosingOrigins?: {
    user: number;
    assistant: number;
    mixed: number;
  };
  recapCooldownMinutes: number;
  total: number;
  activeTotal: number;
  userActiveTotal: number;
  userActiveSessionOnly?: number;
  assistantBacklog: number;
  eligibleTotal: number;
  coolingDown: number;
  dailySurfaced: number;
  dailySurfaceLimit: number;
  dailyCapReached: boolean;
  revisitDays: number;
  revisitReady: number;
  revisitWaiting: number;
  confirmedIds: string[];
  noiseSuppressed: number;
  feedbackTotal: number;
  surfacedTotal: number;
  marked: string[];
  cacheAgeHours?: number;
  cacheStale: boolean;
  activeDays: number;
  activeProjects: ProjectSummary[];
  reconcileCandidates: ReconcileCacheCandidate[];
}
