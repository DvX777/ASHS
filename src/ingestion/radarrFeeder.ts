// src/ingestion/radarrFeeder.ts - Automated background queue feeder & disc/fake release purger for Radarr
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

  // Setup release profile to block fake .exe and raw BDMV disc dumps
  await ensureReleaseFilters().catch(() => {});

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

async function ensureReleaseFilters(): Promise<void> {
  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  try {
    const res = await fetch(`${radarrUrl}/api/v3/releaseprofile`, { headers });
    if (!res.ok) return;
    const profiles = await res.json();
    const existing = profiles.find((p: any) =>
      p.name?.toLowerCase().includes("ashs") ||
      p.name?.toLowerCase().includes("filter")
    );

    const ignoredTerms = [
      "exe", "rar", "zip", "password", ".exe", ".iso", "iso",
      "bdmv", "complete.bluray", "complete bluray", "full.bluray", "full bluray",
      "m2ts", ".m2ts"
    ];

    if (existing) {
      await fetch(`${radarrUrl}/api/v3/releaseprofile/${existing.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...existing,
          name: "ASHS Anti-Malware & Disc Filter",
          enabled: true,
          ignored: ignoredTerms,
        }),
      });
      Logger.info("[RadarrFeeder] Updated Anti-Malware & Disc Release Profile in Radarr");
    } else {
      await fetch(`${radarrUrl}/api/v3/releaseprofile`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "ASHS Anti-Malware & Disc Filter",
          enabled: true,
          required: [],
          ignored: ignoredTerms,
          indexerId: 0,
          tags: [],
        }),
      });
      Logger.info("[RadarrFeeder] Created Anti-Malware & Disc Release Profile in Radarr (blocks .exe, BDMV, .m2ts)");
    }
  } catch (err: any) {
    Logger.warn(`[RadarrFeeder] Could not configure release profile: ${err.message}`);
  }
}

async function feederTick(): Promise<void> {
  if (!Config.RADARR_API_KEY) return;

  // Check if Radarr is online
  const status = await RadarrClient.getStatus();
  if (!status.online) return;

  // Check current queue length in Radarr
  const queue = await RadarrClient.getQueue();

  // 1. Auto-purge any fake, stuck, or raw disc dump releases (e.g. .exe files or raw BDMV .m2ts structures)
  for (const q of queue) {
    const titleLower = (q.title || "").toLowerCase();
    const releaseTitleLower = (q.releaseTitle || "").toLowerCase();
    const isExe = titleLower.endsWith(".exe") || releaseTitleLower.endsWith(".exe") || titleLower.includes(".exe");
    const isBdmv = titleLower.includes("bdmv") || releaseTitleLower.includes("bdmv") ||
                  titleLower.includes("complete.bluray") || releaseTitleLower.includes("complete.bluray") ||
                  titleLower.includes("m2ts") || releaseTitleLower.includes("m2ts");
    const statusMsg = JSON.stringify(q.statusMessages || []).toLowerCase();
    const unimportable = statusMsg.includes("no files found are eligible for import") ||
                        statusMsg.includes("not a video file") ||
                        statusMsg.includes("manual import");

    if (isExe || isBdmv || (q.trackedDownloadStatus === "warning" && unimportable)) {
      Logger.warn(`[RadarrFeeder] Auto-purging stuck/unsupported release: "${q.title}" (ID: ${q.id})`);
      await RadarrClient.deleteQueueItem(q.id, true, true).catch(() => {});
      if (q.movieId) {
        // Trigger search for legitimate single-file .mkv/.mp4 release
        await RadarrClient.autoSearch(q.movieId).catch(() => {});
      }
    }
  }

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
