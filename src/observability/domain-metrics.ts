/**
 * Claw Task Service — Domain Metrics Collector (M10)
 *
 * Zero-dependency counters for business-domain observability:
 *   - Task lifecycle counters (created / archived / completed / cancelled
 *     plus per-transition status-change counters)
 *   - Webhook delivery counters (dispatch invocations + per-status
 *     delivery attempts)
 *
 * These counters are rendered into the Prometheus-format /metrics
 * endpoint (see src/index.ts) alongside the HTTP/intent/process metrics.
 */

// ─── Types ─────────────────────────────────────────────────────────

export interface TaskTransitionMetric {
  from: string;
  to: string;
  count: number;
}

export interface WebhookDeliveryMetric {
  status: string;
  count: number;
}

export interface DomainMetricsSnapshot {
  tasks: {
    created: number;
    archived: number;
    completed: number;
    cancelled: number;
    statusChanges: TaskTransitionMetric[];
  };
  webhooks: {
    dispatches: number;
    deliveries: WebhookDeliveryMetric[];
  };
}

// ─── Collector ─────────────────────────────────────────────────────

class DomainMetricsCollector {
  private taskCreated: number = 0;
  private taskArchived: number = 0;
  private taskCompleted: number = 0;
  private taskCancelled: number = 0;
  private taskTransitions: Map<string, TaskTransitionMetric> = new Map();

  private webhookDispatches: number = 0;
  private webhookDeliveries: Map<string, WebhookDeliveryMetric> = new Map();

  // ─── Task lifecycle ──────────────────────────────────────────

  /** Count a successfully created task. */
  recordTaskCreated(): void {
    this.taskCreated++;
  }

  /** Count an archived (soft-deleted) task. */
  recordTaskArchived(): void {
    this.taskArchived++;
  }

  /** Count a lifecycle transition; completed/cancelled are derived. */
  recordTaskTransition(from: string, to: string): void {
    const key = `${from}->${to}`;
    const existing = this.taskTransitions.get(key);
    if (existing) {
      existing.count++;
    } else {
      this.taskTransitions.set(key, { from, to, count: 1 });
    }
    if (to === 'completed') this.taskCompleted++;
    if (to === 'cancelled') this.taskCancelled++;
  }

  // ─── Webhook delivery ────────────────────────────────────────

  /** Count a webhook dispatch invocation (synchronous, fire-and-forget safe). */
  recordWebhookDispatch(): void {
    this.webhookDispatches++;
  }

  /** Count a delivery attempt by its final status (delivered|failed). */
  recordWebhookDelivery(status: string): void {
    const existing = this.webhookDeliveries.get(status);
    if (existing) {
      existing.count++;
    } else {
      this.webhookDeliveries.set(status, { status, count: 1 });
    }
  }

  // ─── Snapshot ────────────────────────────────────────────────

  getMetrics(): DomainMetricsSnapshot {
    return {
      tasks: {
        created: this.taskCreated,
        archived: this.taskArchived,
        completed: this.taskCompleted,
        cancelled: this.taskCancelled,
        statusChanges: [...this.taskTransitions.values()].sort((a, b) => b.count - a.count),
      },
      webhooks: {
        dispatches: this.webhookDispatches,
        deliveries: [...this.webhookDeliveries.values()].sort((a, b) => b.count - a.count),
      },
    };
  }

  /** Reset all counters (test utility). */
  reset(): void {
    this.taskCreated = 0;
    this.taskArchived = 0;
    this.taskCompleted = 0;
    this.taskCancelled = 0;
    this.taskTransitions.clear();
    this.webhookDispatches = 0;
    this.webhookDeliveries.clear();
  }
}

// ─── Singleton ─────────────────────────────────────────────────────

export const domainMetrics = new DomainMetricsCollector();

export { DomainMetricsCollector };
