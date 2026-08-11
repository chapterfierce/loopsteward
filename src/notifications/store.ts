/**
 * Claw Task Service — Webhook Store (M8)
 *
 * In-memory store for webhook registrations and delivery history.
 * Provides CRUD operations and event matching.
 */

import type {
  WebhookConfig,
  WebhookDelivery,
  WebhookEventType,
  CreateWebhookInput,
  ModifyWebhookInput,
} from './types.js';
import { validateUrl } from './webhook.js';
import { serviceLogger } from '../observability/service-logger.js';
import * as crypto from 'node:crypto';

function generateWebhookId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export class WebhookStore {
  private webhooks = new Map<string, WebhookConfig>();
  private deliveries = new Map<string, WebhookDelivery[]>();

  /** Register a new webhook. Returns the created config. */
  create(input: CreateWebhookInput): WebhookConfig {
    if (!input.url || !validateUrl(input.url)) {
      throw new Error('Invalid webhook URL');
    }
    if (!input.events?.length) {
      throw new Error('At least one event type is required');
    }

    const now = new Date().toISOString();
    const config: WebhookConfig = {
      id: generateWebhookId(),
      url: input.url,
      events: input.events,
      secret: input.secret,
      metadata: input.metadata ?? {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this.webhooks.set(config.id, config);
    serviceLogger.info('Webhook registered', { webhookId: config.id, url: config.url, events: config.events });

    return config;
  }

  /** Get a webhook by ID. Omits secret from returned object. */
  getById(id: string): Omit<WebhookConfig, 'secret'> | undefined {
    const w = this.webhooks.get(id);
    if (!w) return undefined;
    const { secret: _omit, ...pub } = w;
    return pub;
  }

  /** Get full config (including secret) for internal use. */
  getByIdWithSecret(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  /** List all webhooks (omits secrets). */
  list(): Omit<WebhookConfig, 'secret'>[] {
    return Array.from(this.webhooks.values()).map(({ secret: _omit, ...pub }) => pub);
  }

  /** Update a webhook. Returns updated config or undefined. */
  update(id: string, patch: ModifyWebhookInput): Omit<WebhookConfig, 'secret'> | undefined {
    const existing = this.webhooks.get(id);
    if (!existing) return undefined;

    const updated: WebhookConfig = {
      ...existing,
      url: patch.url ?? existing.url,
      events: patch.events ?? existing.events,
      secret: patch.secret !== undefined ? patch.secret : existing.secret,
      metadata: patch.metadata ?? existing.metadata,
      enabled: patch.enabled ?? existing.enabled,
      updatedAt: new Date().toISOString(),
    };

    this.webhooks.set(id, updated);
    serviceLogger.info('Webhook updated', { webhookId: id, changes: Object.keys(patch) });

    const { secret: _omit, ...pub } = updated;
    return pub;
  }

  /** Delete a webhook. Returns true if it existed. */
  delete(id: string): boolean {
    const existed = this.webhooks.delete(id);
    if (existed) {
      serviceLogger.info('Webhook deleted', { webhookId: id });
    }
    return existed;
  }

  /** Find all webhooks subscribed to a given event that are enabled. */
  findByEvent(event: WebhookEventType): WebhookConfig[] {
    return Array.from(this.webhooks.values()).filter((w) => w.enabled && w.events.includes(event));
  }

  /** Record a delivery attempt. */
  recordDelivery(delivery: WebhookDelivery): void {
    const history = this.deliveries.get(delivery.webhookId) ?? [];
    history.push(delivery);
    // Keep last 100 deliveries per webhook
    if (history.length > 100) history.shift();
    this.deliveries.set(delivery.webhookId, history);
  }

  /** Get delivery history for a webhook. */
  getDeliveries(webhookId: string, limit = 20): WebhookDelivery[] {
    const history = this.deliveries.get(webhookId) ?? [];
    return history.slice(-limit);
  }

  /** Count active (enabled) webhooks. */
  count(): { total: number; enabled: number } {
    let enabled = 0;
    for (const w of this.webhooks.values()) {
      if (w.enabled) enabled++;
    }
    return { total: this.webhooks.size, enabled };
  }

  // ─── Internal helpers ───────────────────────────────────────────

  private validateUrl(url: string): boolean {
    return /^https?:\/\/.+/i.test(url) && url.length <= 2048;
  }
}
