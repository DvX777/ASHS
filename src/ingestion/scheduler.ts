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
