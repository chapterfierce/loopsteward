export interface MagpieSourceRef {
  agent: string;
  session: string;
  dir: string;
  quote: string;
  at: string;
}

export interface MagpieMemoryRecord {
  id: string;
  text: string;
  kind: string;
  scope: string;
  why: string;
  origin: string;
  status: string;
  sources: MagpieSourceRef[];
  created: string;
  updated: string;
}

export interface MagpieProject {
  key: string;
  name: string;
  roots: string[];
}

export interface MagpieMemoryFile {
  version: number;
  memories: MagpieMemoryRecord[];
  projects: Record<string, MagpieProject>;
  published: string;
}

export interface MagpieDistillFile {
  done: Record<string, string>;
  last?: string;
  dream: boolean;
}

export interface MagpieSignal extends MagpieMemoryRecord {
  projectKey: string;
  projectName: string;
  projectDir: string | null;
  agents: string[];
  sessions: string[];
  contentHash: string;
}

export interface MagpieScanSummary {
  total: number;
  byAgent: Record<string, number>;
  byProject: Array<{ project: string; count: number }>;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  distill: {
    totalSessions: number;
    byAgent: Record<string, number>;
    last: string | null;
  };
}

export interface MagpieScanResult {
  home: string;
  memory: MagpieMemoryFile;
  distill?: MagpieDistillFile;
  signals: MagpieSignal[];
  summary: MagpieScanSummary;
}
