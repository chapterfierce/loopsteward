/**
 * Claw Task Service — Email Channel (M8)
 *
 * Sends email notifications via SMTP configuration.
 * Uses nodemailer-compatible transport (configured via env vars).
 *
 * Env vars:
 *   SMTP_HOST   — SMTP server hostname
 *   SMTP_PORT   — SMTP port (default 587)
 *   SMTP_USER   — SMTP username
 *   SMTP_PASS   — SMTP password
 *   SMTP_FROM   — From address (default: noreply@claw-task-service)
 */

export interface EmailChannelConfig {
  host: string;
  port?: number;
  secure?: boolean; // true for port 465, false for others
  user: string;
  pass: string;
  from?: string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export class EmailChannel {
  private readonly config: EmailChannelConfig;

  constructor(config: EmailChannelConfig) {
    this.config = {
      port: 587,
      secure: false,
      from: 'noreply@claw-task-service',
      ...config,
    };
  }

  /**
   * Send an email notification.
   * Returns true if sent successfully.
   */
  async send(msg: EmailMessage): Promise<boolean> {
    const { host, port, secure, user, pass, from } = this.config;

    // Dynamic import to avoid hard dependency when email is not configured
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer') as any;
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });

      await transporter.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build a task notification email.
   */
  buildTaskEmail(
    event: string,
    taskTitle: string,
    taskId: string,
    details: Record<string, unknown>,
  ): EmailMessage {
    const subject = `[Claw] Task event: ${event} — ${taskTitle}`;
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: auto;">
  <h2>🛠 Claw Task Notification</h2>
  <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding: 6px 12px; font-weight: bold;">Event</td>
        <td style="padding: 6px 12px;">${event}</td></tr>
    <tr><td style="padding: 6px 12px; font-weight: bold;">Task</td>
        <td style="padding: 6px 12px;">${taskTitle} <small>(ID: ${taskId})</small></td></tr>
    ${Object.entries(details)
      .map(
        ([k, v]) =>
          `<tr><td style="padding: 6px 12px; font-weight: bold;">${k}</td>
               <td style="padding: 6px 12px;">${v}</td></tr>`,
      )
      .join('')}
  </table>
  <hr>
  <p style="color: #888; font-size: 12px;">This notification was sent by Claw Task Service.</p>
</body>
</html>`;

    return { to: [], subject, html, text: `${event}: ${taskTitle} (${taskId})` };
  }

  isConfigured(): boolean {
    return Boolean(this.config.host && this.config.user);
  }
}
