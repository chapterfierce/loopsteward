/**
 * Claw Task Service — Routes Bundle (M8)
 *
 * Registers all REST API routes on an Express app.
 * Call `registerAllRoutes(app, notificationManager)` at startup.
 */

import type { Express } from 'express';
import { registerWebhookRoutes } from './webhooks.js';
import type { NotificationManager } from '../notifications/index.js';

/**
 * Register all API routes on the Express app.
 * Must be called after `app.set('notificationManager', mgr)`.
 */
export function registerAllRoutes(app: Express, mgr: NotificationManager): void {
  app.set('notificationManager', mgr);
  registerWebhookRoutes(app);
}

export { registerWebhookRoutes };
