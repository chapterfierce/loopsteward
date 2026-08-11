/**
 * Claw Task Service — Webhook Routes (M8)
 *
 * Registers /api/v1/webhooks REST API on an Express app.
 *
 * Endpoints:
 *   POST   /api/v1/webhooks              — Register a webhook
 *   GET    /api/v1/webhooks              — List all webhooks
 *   GET    /api/v1/webhooks/:id          — Get a webhook by ID
 *   PATCH  /api/v1/webhooks/:id          — Update a webhook
 *   DELETE /api/v1/webhooks/:id          — Delete a webhook
 *   GET    /api/v1/webhooks/:id/deliveries — Get delivery history
 *
 * Expects `notificationManager` to be attached to `req.app`:
 *   app.set('notificationManager', notificationManager);
 */

import type { Express } from 'express';
import type { NotificationManager } from '../notifications/index.js';
import type {
  CreateWebhookInput,
  ModifyWebhookInput,
  WebhookEventType,
} from '../notifications/types.js';

const VALID_EVENTS: WebhookEventType[] = [
  'task.created',
  'task.status_changed',
  'task.deleted',
  'task.lifecycle.invalid_transition',
];

function validateEvents(events: unknown): events is WebhookEventType[] {
  if (!Array.isArray(events)) return false;
  return events.every((e) => VALID_EVENTS.includes(e as WebhookEventType));
}

function validateUrl(url: string): boolean {
  return /^https?:\/\/.+/i.test(url) && url.length <= 2048;
}

export function registerWebhookRoutes(app: Express): void {
  // ── POST /api/v1/webhooks — Register ───────────────────────────

  app.post('/api/v1/webhooks', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }

    const { url, events, secret, metadata } = req.body as CreateWebhookInput;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ success: false, message: 'url is required and must be a string' });
      return;
    }
    if (!validateUrl(url)) {
      res.status(400).json({ success: false, message: 'url must be a valid HTTP(S) URL (≤2048 chars)' });
      return;
    }
    if (!validateEvents(events)) {
      res.status(400).json({
        success: false,
        message: `events is required and must be one or more of: ${VALID_EVENTS.join(', ')}`,
      });
      return;
    }

    try {
      const created = mgr.createWebhook({ url, events, secret, metadata });
      // Return the sanitized version (without secret) via getById
      const webhook = mgr.getWebhook(created.id);
      res.status(201).json({ success: true, webhook });
    } catch (err) {
      res.status(400).json({ success: false, message: (err as Error).message });
    }
  });

  // ── GET /api/v1/webhooks — List ────────────────────────────────

  app.get('/api/v1/webhooks', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }
    const webhooks = mgr.listWebhooks();
    res.json({ success: true, webhooks, count: webhooks.length });
  });

  // ── GET /api/v1/webhooks/:id — Get one ─────────────────────────

  app.get('/api/v1/webhooks/:id', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }
    const webhook = mgr.getWebhook(req.params['id']);
    if (!webhook) {
      res.status(404).json({ success: false, message: `Webhook not found: ${req.params['id']}` });
      return;
    }
    res.json({ success: true, webhook });
  });

  // ── PATCH /api/v1/webhooks/:id — Update ────────────────────────

  app.patch('/api/v1/webhooks/:id', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }

    const { url, events, secret, metadata, enabled } = req.body as ModifyWebhookInput;

    if (url !== undefined && !validateUrl(url)) {
      res.status(400).json({ success: false, message: 'Invalid url format' });
      return;
    }
    if (events !== undefined && !validateEvents(events)) {
      res.status(400).json({
        success: false,
        message: `events must be one or more of: ${VALID_EVENTS.join(', ')}`,
      });
      return;
    }

    const webhook = mgr.updateWebhook(req.params['id'], { url, events, secret, metadata, enabled });
    if (!webhook) {
      res.status(404).json({ success: false, message: `Webhook not found: ${req.params['id']}` });
      return;
    }
    res.json({ success: true, webhook });
  });

  // ── DELETE /api/v1/webhooks/:id — Delete ──────────────────────

  app.delete('/api/v1/webhooks/:id', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }
    const deleted = mgr.deleteWebhook(req.params['id']);
    if (!deleted) {
      res.status(404).json({ success: false, message: `Webhook not found: ${req.params['id']}` });
      return;
    }
    res.json({ success: true, message: 'Webhook deleted' });
  });

  // ── GET /api/v1/webhooks/:id/deliveries — Delivery history ──────

  app.get('/api/v1/webhooks/:id/deliveries', (req: any, res: any) => {
    const mgr = req.app.get('notificationManager') as NotificationManager | undefined;
    if (!mgr) {
      res.status(503).json({ success: false, message: 'Notification manager not configured' });
      return;
    }
    const webhook = mgr.getWebhook(req.params['id']);
    if (!webhook) {
      res.status(404).json({ success: false, message: `Webhook not found: ${req.params['id']}` });
      return;
    }
    const limit = Math.min(parseInt(req.query['limit'] as string, 10) || 20, 100);
    const deliveries = mgr.getWebhookDeliveries(req.params['id'], limit);
    res.json({ success: true, deliveries, count: deliveries.length });
  });
}
