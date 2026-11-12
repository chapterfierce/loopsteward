import { describe, it, expect } from 'vitest';
import { formatSummary } from '../src/magpie/format.js';

describe('formatSummary', () => {
  it('prints counts in a stable, readable order', () => {
    const text = formatSummary({
      total: 3,
      byAgent: { claude: 2, 'qoder-cn': 1 },
      byProject: [{ project: 'alpha', count: 2 }, { project: 'global', count: 1 }],
      byKind: { episode: 2, preference: 1 },
      byStatus: { candidate: 3 },
      distill: {
        totalSessions: 2,
        byAgent: { claude: 1, 'qoder-cn': 1 },
        last: '2026-11-10T00:00:00Z',
      },
    });
    expect(text).toContain('Signals: 3 (candidate=3)');
    expect(text).toContain('Agents: claude=2, qoder-cn=1');
    expect(text).toContain('Projects: alpha=2, global=1');
    expect(text).toContain('Kinds: episode=2, preference=1');
    expect(text).toContain('Distill: 2 sessions (claude=1, qoder-cn=1)');
    expect(text).toContain('Last distill: 2026-11-10T00:00:00Z');
  });
});
