// src/ingestion/scheduler.ts — Cron-based ingestion orchestrator
import { Logger } from "../utils/logger";
import { Discord } from "../utils/discord";
import { discoverContent } from "./discovery";
import { sleep } from "../utils/helpers";
import { isDiskCritical } from "../storage/stats";
import { cleanTempDir } from "../storage/cleanup";
import fs from "fs";

const TRIGGER_FILE = "/tmp/ashs_ingest_trigger";

// Run discovery on a schedule and enqueue pending items
export async function startScheduler(): Promise<void> {
  Logger.info("[Scheduler] Starting ingestion scheduler...");

  // Run discovery cycles on interval
  const INTERVALS = [
    { ms: 6  * 60 * 60 * 1000, label: "6h trending"   },
    { ms: 24 * 60 * 60 * 1000, label: "24h popular"   },
    { ms: 48 * 60 * 60 * 1000, label: "48h top-rated" },
  ];

  // Initial run after 30s startup delay
  await sleep(30_000);
  await runDiscovery();

  // Set up recurring timers
  setInterval(async () => {
    if (isDiskCritical()) {
      Logger.warn("[Scheduler] Disk critical — skipping ingestion");
      return;
    }
    await runDiscovery();
  }, INTERVALS[0].ms);

  scheduleDailyStats();

  // Poll for manual trigger file
  setInterval(async () => {
    if (fs.existsSync(TRIGGER_FILE)) {
      fs.unlinkSync(TRIGGER_FILE);
      Logger.info("[Scheduler] Manual ingest triggered");
      await runDiscovery();
    }
    // Also clean temp dir every hour
    cleanTempDir();
  }, 60 * 60 * 1000);
}

async function runDiscovery(): Promise<void> {
  try {
    Logger.info("[Scheduler] Running discovery...");
    const result = await discoverContent();
    await Discord.info(
      "Discovery Complete",
      `Found ${result.added} new titles to download, ${result.skipped} skipped`
    );
  } catch (err) {
    const msg = (err as Error).message;
    Logger.error(`[Scheduler] Discovery failed: ${msg}`);
    await Discord.error("Discovery Failed", msg);
  }
}

// Daily stats report at 9:00 AM UTC
function scheduleDailyStats(): void {
  function msUntilNext9am(): number {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }
  function scheduleNext() {
    setTimeout(async () => {
      await sendDailyStats();
      scheduleNext();
    }, msUntilNext9am());
  }
  scheduleNext();
  Logger.info(`[Scheduler] Daily stats report scheduled (next in ${Math.round(msUntilNext9am()/3600000)}h)`);
}

async function sendDailyStats(): Promise<void> {
  try {
    const { db }       = await import("../db");
    const { getMediaStats } = await import("../storage/stats");
    const { formatBytes } = await import("../utils/helpers");

    const lib    = db.prepare("SELECT type, COUNT(*) as c FROM media WHERE status='ready' GROUP BY type").all() as any[];
    const libMap = Object.fromEntries(lib.map((r: any) => [r.type, r.c]));
    const queue  = db.prepare("SELECT status, COUNT(*) as c FROM download_queue GROUP BY status").all() as any[];
    const qMap   = Object.fromEntries((queue as any[]).map((r: any) => [r.status, r.c]));
    const disk   = getMediaStats();
    const files  = (db.prepare("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").get() as any).c;
    const bytes  = (db.prepare("SELECT COALESCE(SUM(file_size),0) as s FROM media_files WHERE status='complete'").get() as any).s;

    await Discord.info(
      "📊 Daily Library Report",
      [
        `🎬 Movies ready: **${libMap.movie ?? 0}**`,
        `📺 TV shows ready: **${libMap.tv ?? 0}**`,
        `📁 Total files: **${files}** (${formatBytes(bytes)})`,
        ``,
        `⏳ Queue — pending: **${qMap.queued ?? 0}** | active: **${qMap.active ?? 0}** | done: **${qMap.done ?? 0}** | failed: **${qMap.failed ?? 0}**`,
        ``,
        `💾 HDD: **${formatBytes(disk.used)} / ${formatBytes(disk.total)}** (${(disk.percent * 100).toFixed(1)}% used)`,
      ].join("\n")
    );
  } catch (err) {
    Logger.error(`[Scheduler] Daily stats failed: ${(err as Error).message}`);
  }
}
