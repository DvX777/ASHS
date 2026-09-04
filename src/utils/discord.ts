// src/utils/discord.ts — Discord webhook notifications

import { Config } from "../config";
import { Logger } from "./logger";

type AlertLevel = "info" | "success" | "warning" | "error";

const COLORS: Record<AlertLevel, number> = {
  info: 0x5865f2,     // Blue
  success: 0x57f287,  // Green
  warning: 0xfee75c,  // Yellow
  error: 0xed4245,    // Red
};

const EMOJIS: Record<AlertLevel, string> = {
  info: "🔵",
  success: "🟢",
  warning: "🟡",
  error: "🔴",
};

export async function notify(
  title: string,
  description: string,
  level: AlertLevel = "info"
): Promise<void> {
  const url = Config.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: `${EMOJIS[level]} ${title}`,
            description,
            color: COLORS[level],
            timestamp: new Date().toISOString(),
            footer: { text: "ASHS — MoviesDB" },
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Never let Discord failure crash anything
    Logger.warn(`[Discord] Webhook failed: ${(err as Error).message}`);
  }
}

// Shorthand helpers
export const Discord = {
  info: (title: string, desc: string) => notify(title, desc, "info"),
  success: (title: string, desc: string) => notify(title, desc, "success"),
  warning: (title: string, desc: string) => notify(title, desc, "warning"),
  error: (title: string, desc: string) => notify(title, desc, "error"),
};
