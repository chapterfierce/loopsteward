/**
 * Claw Task Service — DingTalk Channel (M8)
 *
 * Sends notifications via DingTalk custom robot webhook.
 * https://developers.dingtalk.com/document/app/custom-robot-access
 *
 * Env vars:
 *   DINGTALK_WEBHOOK_URL  — Full DingTalk robot webhook URL (includes access_token)
 *   DINGTALK_SECRET       — (optional) Robot secret for signature
 */

export interface DingTalkMessage {
  /** Message content text */
  text: string;
  /** Optional At mobile numbers (they will be highlighted) */
  atMobiles?: string[];
  /** Whether to notify all */
  isAtAll?: boolean;
}

export class DingTalkChannel {
  private readonly webhookUrl: string;
  private readonly secret?: string;

  constructor(webhookUrl: string, secret?: string) {
    this.webhookUrl = webhookUrl;
    this.secret = secret;
  }

  /**
   * Send a message to the DingTalk group.
   * Returns true if sent successfully (HTTP 200).
   */
  async send(msg: DingTalkMessage): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        msgtype: 'text',
        text: { content: msg.text },
        at: {
          atMobiles: msg.atMobiles ?? [],
          isAtAll: msg.isAtAll ?? false,
        },
      };

      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        return false;
      }

      const json = await res.json() as { errcode?: number; errmsg?: string };
      return json.errcode === 0 || json.errcode === undefined;
    } catch {
      return false;
    }
  }

  /**
   * Build a task event DingTalk message with formatted content.
   */
  buildTaskMessage(event: string, taskTitle: string, taskId: string, details: Record<string, unknown>): DingTalkMessage {
    const lines = [
      `🔔 **${event}**`,
      `📋 Task: ${taskTitle}`,
      `🔖 ID: ${taskId}`,
    ];

    for (const [k, v] of Object.entries(details)) {
      lines.push(`${k}: ${v}`);
    }

    return {
      text: lines.join('\n'),
      isAtAll: false,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }
}
