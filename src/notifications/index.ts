/**
 * Claw Task Service — Notifications Bundle (M8)
 *
 * Exports all notification components:
 *   - WebhookService  — core delivery engine
 *   - WebhookStore    — registration CRUD
 *   - EmailChannel    — SMTP email notifications
 *   - DingTalkChannel — DingTalk robot notifications
 *   - WeComChannel    — 企业微信 robot notifications
 *   - NotificationManager — coordinates dispatch across channels
 *
 * Usage:
 *   import { WebhookService, WebhookStore, NotificationManager } from './notifications/index.js';
 */

export { WebhookService, validateUrl } from './webhook.js';
export type { RetryConfig, DeliveryResult } from './webhook.js';
export { WebhookStore } from './store.js';
export { EmailChannel } from './channels/email.js';
export type { EmailChannelConfig, EmailMessage } from './channels/email.js';
export { DingTalkChannel } from './channels/dingtalk.js';
export type { DingTalkMessage } from './channels/dingtalk.js';
export { WeComChannel } from './channels/wecom.js';
export type { WeComMessage } from './channels/wecom.js';
export type {
  WebhookEventType,
  WebhookConfig,
  WebhookDelivery,
  WebhookPayload,
  CreateWebhookInput,
  ModifyWebhookInput,
} from './types.js';

// ─── Notification Manager ────────────────────────────────────────────

import { WebhookService } from './webhook.js';
import { WebhookStore } from './store.js';
import type { DeliveryResult } from './webhook.js';
import type { WebhookConfig, WebhookEventType } from './types.js';
import { serviceLogger } from '../observability/service-logger.js';
import { EmailChannel } from './channels/email.js';
import { DingTalkChannel } from './channels/dingtalk.js';
import { WeComChannel } from './channels/wecom.js';

/**
 * Coordinates notification dispatch across all configured channels.
 * Listens to WebhookService delivery attempts and records them in WebhookStore.
 */
export class NotificationManager {
  private readonly webhookService: WebhookService;
  private readonly store: WebhookStore;

  /** Optional additional channels */
  private emailChannel?: EmailChannel;
  private dingtalkChannel?: DingTalkChannel;
  private wecomChannel?: WeComChannel;

  constructor(store?: WebhookStore, webhookService?: WebhookService) {
    this.store = store ?? new WebhookStore();
    this.webhookService =
      webhookService ??
      new WebhookService({
        timeoutMs: 5000,
        retryConfig: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000 },
      });

    // Wire delivery attempts back to the store
    this.webhookService.setDeliveryCallback((delivery) => {
      this.store.recordDelivery(delivery);
    });
  }

  /** Configure email channel (call once at startup). */
  configureEmail(config: { host: string; port?: number; user: string; pass: string; from?: string }): void {
    this.emailChannel = new EmailChannel(config);
  }

  /** Configure DingTalk channel. */
  configureDingTalk(webhookUrl: string, secret?: string): void {
    this.dingtalkChannel = new DingTalkChannel(webhookUrl, secret);
  }

  /** Configure WeCom channel. */
  configureWeCom(webhookUrl: string): void {
    this.wecomChannel = new WeComChannel(webhookUrl);
  }

  /** Dispatch notifications for an event to all subscribed webhooks.
   *
   * @param event  Event type
   * @param data   Event payload data
   * @returns Array of delivery results (one per webhook)
   */
  async dispatch(event: WebhookEventType, data: Record<string, unknown>): Promise<DeliveryResult[]> {
    const webhooks = this.store.findByEvent(event);
    if (!webhooks.length) return [];

    serviceLogger.info('Dispatching webhook notifications', { event, webhookCount: webhooks.length });

    const results = await Promise.all(
      webhooks.map((config) =>
        this.webhookService.send(config, undefined, event, data),
      ),
    );

    // Also send to additional channels (fire-and-forget)
    void this.dispatchToChannels(event, data);

    return results;
  }

  private async dispatchToChannels(event: WebhookEventType, data: Record<string, unknown>): Promise<void> {
    const task = data['task'] as Record<string, unknown> | undefined;
    if (!task) return;

    const taskTitle = String(task['title'] ?? 'Unknown');
    const taskId = String(task['id'] ?? '?');

    // Email — send to configured recipients
    if (this.emailChannel?.isConfigured()) {
      const msg = this.emailChannel.buildTaskEmail(event, taskTitle, taskId, data);
      await this.emailChannel.send(msg);
    }

    // DingTalk
    if (this.dingtalkChannel?.isConfigured()) {
      const msg = this.dingtalkChannel.buildTaskMessage(event, taskTitle, taskId, data);
      await this.dingtalkChannel.send(msg);
    }

    // WeCom
    if (this.wecomChannel?.isConfigured()) {
      const msg = this.wecomChannel.buildTaskMessage(event, taskTitle, taskId, data);
      await this.wecomChannel.send(msg);
    }
  }

  // ─── Webhook CRUD (delegated to store) ────────────────────────────

  createWebhook(input: Parameters<WebhookStore['create']>[0]): ReturnType<WebhookStore['create']> {
    return this.store.create(input);
  }

  getWebhook(id: string): ReturnType<WebhookStore['getById']> {
    return this.store.getById(id);
  }

  getWebhookWithSecret(id: string): WebhookConfig | undefined {
    return this.store.getByIdWithSecret(id);
  }

  listWebhooks(): ReturnType<WebhookStore['list']> {
    return this.store.list();
  }

  updateWebhook(id: string, patch: Parameters<WebhookStore['update']>[1]): ReturnType<WebhookStore['update']> {
    return this.store.update(id, patch);
  }

  deleteWebhook(id: string): boolean {
    return this.store.delete(id);
  }

  getWebhookDeliveries(webhookId: string, limit?: number): ReturnType<WebhookStore['getDeliveries']> {
    return this.store.getDeliveries(webhookId, limit);
  }
}
