/**
 * Claw Task Service — Notification Types (M8)
 *
 * Shared types for the webhook + channel notification system.
 */

export type WebhookEventType =
  | 'task.created'
  | 'task.status_changed'
  | 'task.deleted'
  | 'task.lifecycle.invalid_transition';

export interface WebhookConfig {
  id: string;
  url: string;
  events: WebhookEventType[];
  /** HMAC secret — never exposed via API */
  secret?: string;
  metadata: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  payload: object;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastAttemptAt?: string;
  responseCode?: number;
  error?: string;
}

export interface WebhookPayload {
  id: string;
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
  secret?: string;
  metadata?: Record<string, unknown>;
}

export interface ModifyWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  secret?: string;
  metadata?: Record<string, unknown>;
  enabled?: boolean;
}
