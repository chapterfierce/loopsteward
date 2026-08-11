/**
 * Claw Task Service — Webhook Service (M8)
 *
 * Core webhook delivery engine:
 *   - send(event, payload)   — POST to registered URL with optional HMAC signature
 *   - retry(event, config)  — exponential backoff retry (1s, 2s, 4s)
 *   - validateUrl(url)       — URL format validation
 *
 * HMAC signature uses HMAC-SHA256 when a secret is configured, sent as:
 *   X-Claw-Signature: sha256=<hex>
 */

import * as crypto from 'node:crypto';
import type {
  WebhookConfig,
  WebhookPayload,
  WebhookDelivery,
  WebhookEventType,
} from './types.js';
import { serviceLogger } from '../observability/service-logger.js';

// ─── URL Validation ────────────────────────────────────────────────

const URL_REGEX = /^https?:\/\/.+/i;

export function validateUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.length > 2048) return false;
  return URL_REGEX.test(url.trim());
}

// ─── HMAC Signature ────────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

// ─── Retry Configuration ────────────────────────────────────────────

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

// ─── Delivery Result ────────────────────────────────────────────────

export interface DeliveryResult {
  id: string;
  webhookId: string;
  success: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}

// ─── WebhookService ─────────────────────────────────────────────────

export class WebhookService {
  /** HTTP timeout per request in ms */
  private readonly timeoutMs: number;

  /** Default retry config */
  private readonly retryConfig: Required<RetryConfig>;

  /** Callback invoked after each delivery attempt */
  private onDeliveryAttempt?: (
    delivery: WebhookDelivery,
  ) => void;

  constructor(
    options?: {
      timeoutMs?: number;
      retryConfig?: RetryConfig;
      onDeliveryAttempt?: (delivery: WebhookDelivery) => void;
    },
  ) {
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.retryConfig = {
      maxAttempts: options?.retryConfig?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      baseDelayMs: options?.retryConfig?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: options?.retryConfig?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    };
    this.onDeliveryAttempt = options?.onDeliveryAttempt;
  }

  /**
   * Set the delivery attempt callback (useful for tracking in WebhookStore).
   */
  setDeliveryCallback(fn: (delivery: WebhookDelivery) => void): void {
    this.onDeliveryAttempt = fn;
  }

  /**
   * Build a WebhookPayload for a given event and data.
   */
  buildPayload(event: WebhookEventType, data: Record<string, unknown>): WebhookPayload {
    return {
      id: generateId('evt'),
      event,
      timestamp: new Date().toISOString(),
      data,
    };
  }

  /**
   * Send a webhook notification to the given config.
   *
   * @param config  Webhook registration
   * @param payload Pre-built payload (pass undefined to build inline)
   * @param event   Event type (used if payload is not provided)
   * @param data    Event data (used if payload is not provided)
   */
  async send(
    config: WebhookConfig,
    payload?: WebhookPayload,
    event?: WebhookEventType,
    data?: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const resolvedPayload = payload ?? this.buildPayload(event!, data!);
    const result = await this.sendWithRetry(config, resolvedPayload);
    return result;
  }

  private async sendWithRetry(
    config: WebhookConfig,
    payload: WebhookPayload,
  ): Promise<DeliveryResult> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.retryConfig;
    let lastError = '';
    let lastStatusCode: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const delivery: WebhookDelivery = {
        id: generateId('dlv'),
        webhookId: config.id,
        event: payload.event,
        payload,
        status: 'pending',
        attempts: attempt,
      };

      try {
        const result = await this.doSend(config, payload);
        lastStatusCode = result.statusCode;

        if (result.success) {
          delivery.status = 'delivered';
          delivery.responseCode = result.statusCode;
          delivery.lastAttemptAt = new Date().toISOString();
          this.onDeliveryAttempt?.(delivery);

          serviceLogger.info('Webhook delivered', {
            webhookId: config.id,
            event: payload.event,
            attempt,
            statusCode: result.statusCode,
            deliveryId: delivery.id,
          });

          return {
            id: delivery.id,
            webhookId: config.id,
            success: true,
            attempts: attempt,
            statusCode: result.statusCode,
          };
        } else {
          lastError = `HTTP ${result.statusCode}`;
          delivery.status = 'failed';
          delivery.responseCode = result.statusCode;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        delivery.status = 'failed';
        delivery.error = lastError;
      }

      delivery.lastAttemptAt = new Date().toISOString();
      this.onDeliveryAttempt?.(delivery);

      serviceLogger.warn('Webhook delivery failed, will retry', {
        webhookId: config.id,
        event: payload.event,
        attempt,
        maxAttempts,
        error: lastError,
        deliveryId: delivery.id,
      });

      // Don't sleep after the last attempt
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }

    serviceLogger.error('Webhook delivery exhausted retries', {
      webhookId: config.id,
      event: payload.event,
      attempts: maxAttempts,
      lastError,
      lastStatusCode,
    });

    return {
      id: generateId('dlv'),
      webhookId: config.id,
      success: false,
      attempts: maxAttempts,
      statusCode: lastStatusCode,
      error: lastError,
    };
  }

  private async doSend(
    config: WebhookConfig,
    payload: WebhookPayload,
  ): Promise<{ success: boolean; statusCode: number }> {
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ClawTaskService/2.5.0 Webhook',
      'X-Claw-Event': payload.event,
      'X-Claw-Delivery': payload.id,
    };

    // Add HMAC signature if secret is configured
    if (config.secret) {
      headers['X-Claw-Signature'] = signPayload(body, config.secret);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(config.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Treat 2xx as success
      const success = res.status >= 200 && res.status < 300;
      return { success, statusCode: res.status };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Calculate the exponential backoff delay for a given attempt number.
   * Exposed for testing purposes.
   */
  calcBackoff(attempt: number): number {
    return Math.min(
      this.retryConfig.baseDelayMs * 2 ** (attempt - 1),
      this.retryConfig.maxDelayMs,
    );
  }
}

// ─── Utilities ─────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const hex = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${hex}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
