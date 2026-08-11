/**
 * Claw Task Service — WeCom (企业微信) Channel (M8)
 *
 * Sends notifications via WeCom custom robot webhook.
 * https://developer.work.weixin.qq.com/document/path/91770
 *
 * Env vars:
 *   WECOM_WEBHOOK_URL  — Full WeCom robot webhook URL (includes key)
 */

export interface WeComMessage {
  /** Message content (markdown is supported) */
  content: string;
  /** Whether to mention users by mobile */
  mentionedMobileList?: string[];
}

export class WeComChannel {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  /**
   * Send a markdown message to the WeCom group.
   * Returns true if sent successfully.
   */
  async send(msg: WeComMessage): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        msgtype: 'markdown',
        markdown: {
          content: msg.content,
          mentioned_mobile_list: msg.mentionedMobileList ?? [],
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
      return json.errcode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Build a task event WeCom markdown message.
   */
  buildTaskMessage(event: string, taskTitle: string, taskId: string, details: Record<string, unknown>): WeComMessage {
    const lines = [
      `> **${event}**`,
      `> 📋 **${taskTitle}**`,
      `> 🔖 ID: \`${taskId}\``,
    ];

    for (const [k, v] of Object.entries(details)) {
      lines.push(`> ${k}: **${v}**`);
    }

    return {
      content: lines.join('\n'),
    };
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }
}
