// src/ingestion/scheduler.ts — Cron-based ingestion orchestrator
import { Logger } from "../utils/logger";
import { Discord, notifyDailyStats } from "../utils/discord";
import { discoverContent } from "./discovery";
import { runSRR } from "./srr";
import { sleep } from "../utils/helpers";
import { db } from "../db";
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
  await runSRR();   // heal any broken state first
  await runDiscovery();

  // Set up recurring timers
  setInterval(async () => {
    if (isDiskCritical()) {
      Logger.warn("[Scheduler] Disk critical — skipping ingestion");
      return;
    }
    await runSRR();
    await runDiscovery();
  }, INTERVALS[0].ms);

  scheduleDailyStats();

  // Auto-heal: every 60s, fix media that has complete files but wrong status
  // This is the permanent fix for 'Complete Files Not Ready' - no manual button needed
  setInterval(() => {
    try {
      const fixed = db.prepare(`
        UPDATE media SET status='ready', updated_at=datetime('now')
        WHERE status NOT IN ('ready','removed')
          AND id IN (SELECT DISTINCT media_id FROM media_files WHERE status='complete')
      `).run().changes;
      if (fixed > 0) Logger.info(`[AutoHeal] Restored ${fixed} media to ready`);
    } catch (e) {
      Logger.warn('[AutoHeal] Error: ' + (e as Error).message);
    }
  }, 60_000);
  scheduleStaleRefresh();

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

    await notifyDailyStats({
      movies:   libMap.movie  ?? 0,
      tvShows:  libMap.tv     ?? 0,
      files:    files,
      bytes:    bytes,
      queued:   qMap.queued   ?? 0,
      active:   qMap.active   ?? 0,
      done:     qMap.done     ?? 0,
      failed:   qMap.failed   ?? 0,
      hddUsed:  disk.used,
      hddTotal: disk.total,
    });
  } catch (err) {
    Logger.error(`[Scheduler] Daily stats failed: ${(err as Error).message}`);
  }
}

// Weekly stale content refresh — re-fetches TMDB metadata for 'ready' media
// Updated metadata (poster, rating, overview) improves library quality
function scheduleStaleRefresh(): void {
  function msUntilSunday3am(): number {
    const now  = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0));
    // Advance to next Sunday
    const daysUntilSun = (7 - now.getUTCDay()) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + daysUntilSun);
    return next.getTime() - now.getTime();
  }
  function scheduleNext() {
    setTimeout(async () => {
      await runStaleRefresh();
      scheduleNext();
    }, msUntilSunday3am());
  }
  scheduleNext();
  Logger.info("[Scheduler] Weekly TMDB stale refresh scheduled (Sundays 3 AM UTC)");
}

async function runStaleRefresh(): Promise<void> {
  Logger.info("[StaleRefresh] Refreshing TMDB metadata for ready content...");
  try {
    const { db }    = await import("../db");
    const stale     = db.prepare(`
      SELECT * FROM media WHERE status IN ('ready','downloading')
        AND (updated_at < datetime('now', '-7 days') OR poster_path IS NULL)
      ORDER BY popularity DESC LIMIT 200
    `).all() as any[];

    let updated = 0;
    for (const m of stale) {
      const endpoint = m.type === "tv"
        ? "https://api.themoviedb.org/3/tv/" + m.tmdb_id
        : "https://api.themoviedb.org/3/movie/" + m.tmdb_id;
      try {
        const res = await fetch(endpoint + "?api_key=" + Config.TMDB_API_KEY,
          { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const d: any = await res.json();

        db.prepare(`UPDATE media SET
          poster_path=?, backdrop_path=?, overview=?, genres=?,
          vote_average=?, vote_count=?, popularity=?, runtime=?,
          updated_at=datetime('now') WHERE id=?`
        ).run(
          d.poster_path ?? m.poster_path,
          d.backdrop_path ?? m.backdrop_path,
          d.overview ?? m.overview,
          JSON.stringify((d.genres || []).map((g: any) => g.name)),
          d.vote_average ?? m.vote_average,
          d.vote_count   ?? m.vote_count,
          d.popularity   ?? m.popularity,
          d.runtime ?? d.episode_run_time?.[0] ?? m.runtime,
          m.id
        );
        updated++;
        await sleep(300); // gentle rate-limit
      } catch {}
    }
    Logger.info("[StaleRefresh] Updated " + updated + " / " + stale.length + " records");
    await Discord.info("TMDB Refresh Complete", "Updated metadata for " + updated + " titles");
  } catch (err) {
    Logger.error("[StaleRefresh] Failed: " + (err as Error).message);
  }
}
