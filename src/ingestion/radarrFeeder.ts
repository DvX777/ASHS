// src/ingestion/radarrFeeder.ts - Automated background queue feeder for Radarr
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { db } from "../db";
import { RadarrClient } from "../integrations/radarr";
import { sleep } from "../utils/helpers";

let _feederActive = false;

export async function startRadarrFeeder(): Promise<void> {
  if (!Config.RADARR_ENABLED) {
    Logger.info("[RadarrFeeder] RADARR_ENABLED is false; feeder inactive");
    return;
  }
  if (_feederActive) return;
  _feederActive = true;
  Logger.info("[RadarrFeeder] Starting automated Radarr queue feeder (30s interval, 20 max slots)...");

  // Initial delay so system services are up
  await sleep(15_000);

  // Initial sync with Radarr library
  await RadarrClient.syncMoviesWithASHS().catch(() => {});

  let tickCount = 0;
  while (true) {
    try {
      await feederTick();
      tickCount++;

      // Every 10 ticks (~5 minutes), run full library reconciliation
      if (tickCount % 10 === 0) {
        await RadarrClient.syncMoviesWithASHS().catch(() => {});
      }
    } catch (err: any) {
      Logger.error(`[RadarrFeeder] Error in feeder tick: ${err.message}`);
    }
    await sleep(30_000);
  }
}

async function feederTick(): Promise<void> {
  if (!Config.RADARR_API_KEY) return;

  // Check if Radarr is online
  const status = await RadarrClient.getStatus();
  if (!status.online) return;

  // Check current queue length in Radarr
  const queue = await RadarrClient.getQueue();
  const activeCount = queue.length;
  const maxSlots = Config.MAX_CONCURRENT_DOWNLOADS || 20;

  // If queue is already handling 15 or more, let them progress
  if (activeCount >= 15) {
    return;
  }

  // Determine how many slots to dispatch
  const slotsToFill = Math.min(5, maxSlots - activeCount);
  if (slotsToFill <= 0) return;

  // Select top pending movies by popularity
  const pendingMovies = db.prepare(`
    SELECT id, tmdb_id, title, year, popularity
    FROM media
    WHERE type = 'movie' AND status = 'pending'
    ORDER BY popularity DESC
    LIMIT ?
  `).all(slotsToFill) as any[];

  if (!pendingMovies.length) return;

  Logger.info(`[RadarrFeeder] Dispatching ${pendingMovies.length} pending movies to Radarr (Slots in use: ${activeCount}/${maxSlots})`);

  for (const m of pendingMovies) {
    try {
      await RadarrClient.addMovie(Number(m.tmdb_id), m.title);
      db.prepare("UPDATE media SET status = 'downloading', updated_at = datetime('now') WHERE id = ?").run(m.id);
      Logger.info(`[RadarrFeeder] Queued for download: "${m.title}" (${m.year}) [Pop: ${m.popularity}]`);
      await sleep(1200); // Friendly pacing for Radarr metadata lookup
    } catch (err: any) {
      Logger.warn(`[RadarrFeeder] Failed to add ${m.title}: ${err.message}`);
      // Update updated_at so it doesn't immediately block the top of the queue
      db.prepare("UPDATE media SET updated_at = datetime('now') WHERE id = ?").run(m.id);
    }
  }
}
