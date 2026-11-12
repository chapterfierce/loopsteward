import type { MagpieScanSummary } from './types.js';

function pairs(values: Record<string, number>): string {
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');
}

export function formatSummary(summary: MagpieScanSummary): string {
  const status = pairs(summary.byStatus);
  const lines = [
    `Signals: ${summary.total}${status ? ` (${status})` : ''}`,
    `Agents: ${pairs(summary.byAgent) || 'none'}`,
    `Projects: ${summary.byProject.map((project) => `${project.project}=${project.count}`).join(', ') || 'none'}`,
    `Kinds: ${pairs(summary.byKind) || 'none'}`,
    `Distill: ${summary.distill.totalSessions} sessions (${pairs(summary.distill.byAgent) || 'none'})`,
  ];
  if (summary.distill.last) lines.push(`Last distill: ${summary.distill.last}`);
  return lines.join('\n');
}
