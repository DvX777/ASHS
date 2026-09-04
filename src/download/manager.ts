// src/download/manager.ts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Priority download queue processor (3 concurrent)
import fs from "fs";
import path from "path";
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { Discord } from "../utils/discord";
import { db, MediaQueries, FileQueries, QueueQueries } from "../db";
import { resolveMovie, resolveTV } from "../ingestion/resolver";
import { downloadFile } from "./downloader";
import { computeSHA256, verifySizeApprox, moveFile } from "./verifier";
import { buildAbsolutePath, buildTempPath, buildRelativePath } from "../storage/paths";
import { isDiskCritical } from "../storage/stats";
import { runCleanupIfNeeded } from "../storage/cleanup";
import { formatBytes, sleep } from "../utils/helpers";

export async function startDownloadManager(): Promise<void> {
  Logger.info("[DownloadManager] Starting...");
  // Ensure directories exist
  fs.mkdirSync(Config.TEMP_DIR,  { recursive: true });
  fs.mkdirSync(Config.MEDIA_DIR, { recursive: true });

  while (true) {
    try {
      await tick();
    } catch (err) {
      Logger.error(`[DownloadManager] Tick error: ${(err as Error).message}`);
    }
    await sleep(5_000);
  }
}

async function tick(): Promise<void> {
  // Pause if disk is critical
  if (isDiskCritical()) {
    Logger.warn("[DownloadManager] Disk critical ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â pausing downloads");
    await runCleanupIfNeeded();
    return;
  }

  const { count: active } = QueueQueries.countActive.get() as { count: number };
  if (active >= Config.MAX_CONCURRENT_DOWNLOADS) return;

  // Find pending media that needs resolving first
  const pending = db.prepare(`
    SELECT * FROM media WHERE status = 'pending' LIMIT 5
  `).all() as any[];

  for (const media of pending) {
    if ((QueueQueries.countActive.get() as any).count >= Config.MAX_CONCURRENT_DOWNLOADS) break;
    resolveAndEnqueue(media).catch(err =>
      Logger.error(`[DownloadManager] Resolve error for ${media.tmdb_id}: ${err.message}`)
    );
    // Stagger resolver calls ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â avoid MovieBox 429 burst
    await sleep(3_000);
  }

  // Process queued jobs
  const { count: nowActive } = QueueQueries.countActive.get() as { count: number };
  if (nowActive >= Config.MAX_CONCURRENT_DOWNLOADS) return;

  const job = QueueQueries.nextQueued.get();
  if (!job) return;

  // Fire and forget ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â don't block tick
  executeDownload(job as any).catch(err =>
    Logger.error(`[DownloadManager] Job ${(job as any).id} crashed: ${err.message}`)
  );
}

async function resolveAndEnqueue(media: any): Promise<void> {
  MediaQueries.setStatus.run("resolving", media.tmdb_id, media.type);
  try {
    if (media.type === "movie") {
      const result = await resolveMovie(media.title, String(media.year ?? ""), media.original_language ?? "en");
      if (!result || result.sources.length === 0) {
        MediaQueries.setStatus.run("failed", media.tmdb_id, media.type);
        return;
      }
      // Save moviebox_id + language
      db.prepare("UPDATE media SET moviebox_id=?, stored_language=?, status='downloading', updated_at=datetime('now') WHERE id=?")
        .run(result.subjectId, result.dubName, media.id);

      // Create file records + enqueue
      for (const src of result.sources) {
        const fileRow = FileQueries.insertFile.get(media.id, 0, 0, src.quality, src.dub, src.type, null);
        if (!fileRow) continue;
        const job = QueueQueries.enqueue.get(media.id, fileRow.id, 20);
        // Store source URL + headers in queue row
        if (job) {
          db.prepare("UPDATE download_queue SET source_url=?, source_headers=? WHERE id=?")
            .run(src.url, JSON.stringify(src.headers), job.id);
        }
      }
    }
    } else if (media.type === "tv") {
      // Fetch season list from TMDB
      const tmdbRes = await fetch(
        `https://api.themoviedb.org/3/tv/${media.tmdb_id}?api_key=${Config.TMDB_API_KEY}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!tmdbRes.ok) { MediaQueries.setStatus.run("failed", media.tmdb_id, media.type); return; }
      const show: any = await tmdbRes.json();
      const seasons: any[] = (show.seasons || []).filter((s: any) => s.season_number > 0);
      if (!seasons.length) { MediaQueries.setStatus.run("failed", media.tmdb_id, media.type); return; }

      MediaQueries.setStatus.run("downloading", media.tmdb_id, media.type);
      let anyEnqueued = false;

      for (const season of seasons.slice(0, 3)) {
        const sNum = season.season_number;
        let epRes: any;
        try {
          epRes = await fetch(
            `https://api.themoviedb.org/3/tv/${media.tmdb_id}/season/${sNum}?api_key=${Config.TMDB_API_KEY}`,
            { signal: AbortSignal.timeout(10_000) }
          );
        } catch { continue; }
        if (!epRes.ok) continue;
        const seasonData: any = await epRes.json();
        const episodes: any[] = seasonData.episodes || [];

        for (const ep of episodes) {
          const eNum = ep.episode_number;
          const sources = await resolveTV(
            media.title, String(media.year ?? ""), media.original_language ?? "en", sNum, eNum
          );
          if (!sources || sources.length === 0) continue;
          anyEnqueued = true;

          for (const src of sources) {
            const relP = buildRelativePath("tv", media.tmdb_id, src.quality, sNum, eNum);
            const absP = path.join(Config.MEDIA_DIR, relP);
            if (fs.existsSync(absP)) continue;
            const fileRow = FileQueries.insertFile.get(media.id, sNum, eNum, src.quality, src.dub, src.type, null);
            if (!fileRow) continue;
            const job = QueueQueries.enqueue.get(media.id, fileRow.id, 30);
            if (job) {
              db.prepare("UPDATE download_queue SET source_url=?, source_headers=? WHERE id=?")
                .run(src.url, JSON.stringify(src.headers), job.id);
            }
          }
          await sleep(2_000);
        }
        await sleep(3_000);
      }

      if (!anyEnqueued) { MediaQueries.setStatus.run("failed", media.tmdb_id, media.type); return; }
      db.prepare("UPDATE media SET stored_language=?, updated_at=datetime('now') WHERE id=?")
        .run(media.original_language ?? "Original", media.id);
  } catch (err) {
    Logger.error(`[Resolver] ${media.tmdb_id}: ${(err as Error).message}`);
    MediaQueries.setStatus.run("failed", media.tmdb_id, media.type);
  }
}

async function executeDownload(job: any): Promise<void> {
  // Skip if file already downloaded and exists on disk
  const relPath   = buildRelativePath(job.type, job.tmdb_id, job.quality, job.season ?? 0, job.episode ?? 0);
  const finalPath = path.join(Config.MEDIA_DIR, relPath);
  if (fs.existsSync(finalPath)) {
    Logger.info(`[Download] Already exists, skipping: ${job.title} ${job.quality}p`);
    QueueQueries.markDone.run(job.id);
    return;
  }

  QueueQueries.markActive.run(job.id);
  const tempPath  = buildTempPath(job.id);

  const headers: Record<string, string> = job.source_headers
    ? JSON.parse(job.source_headers)
    : {};

  try {
    Logger.info(`[Download] Starting: ${job.title} ${job.quality}p (job #${job.id})`);
    FileQueries.setStatus.run("downloading", null, job.media_file_id);

    // Re-resolve if no URL stored or token likely expired (>90min since start)
    let sourceUrl = job.source_url;
    if (!sourceUrl) {
      const media = db.prepare("SELECT * FROM media WHERE id=?").get(job.media_id) as any;
      const res   = await resolveMovie(media.title, String(media.year ?? ""), media.original_language ?? "en");
      const src   = res?.sources.find((s: any) => s.quality === job.quality);
      if (!src) throw new Error("Could not re-resolve source URL");
      sourceUrl = src.url;
      Object.assign(headers, src.headers);
    }

    const { size } = await downloadFile(sourceUrl, headers, tempPath, ({ percent }) => {
      FileQueries.updateProgress.run(percent, job.media_file_id);
    });

    // Verify size (if we know expected size)
    if (job.quality && !verifySizeApprox(tempPath, size)) {
      throw new Error(`Size mismatch: got ${size} bytes`);
    }

    // Compute checksum
    const sha256 = await computeSHA256(tempPath);

    // Dedup: if same checksum exists, hard-link
    const existing = FileQueries.findByChecksum.get(sha256);
    if (existing?.file_path) {
      const existAbs = path.join(Config.MEDIA_DIR, existing.file_path);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      try { fs.linkSync(existAbs, finalPath); } catch { fs.copyFileSync(existAbs, finalPath); }
      fs.unlinkSync(tempPath);
    } else {
      await moveFile(tempPath, finalPath);
    }

    // Update DB
    const stat = fs.statSync(finalPath);
    FileQueries.complete.run(relPath, stat.size, sha256, 0, job.media_file_id);
    QueueQueries.markDone.run(job.id);

    // Check if all files for this media are done
    const { all_done } = FileQueries.allComplete.get(job.media_id) as { all_done: number };
    if (all_done) MediaQueries.setStatus.run("ready", job.tmdb_id, job.type);

    Logger.info(`[Download] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Done: ${job.title} ${job.quality}p (${formatBytes(stat.size)})`);
    await Discord.success("Download Complete", `**${job.title}** ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${job.quality}p (${formatBytes(stat.size)})`);

  } catch (err) {
    const msg = (err as Error).message;
    Logger.error(`[Download] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€¦Ã¢â‚¬â„¢ Failed: ${job.title} ${job.quality}p ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${msg}`);
    FileQueries.setStatus.run("retrying", msg, job.media_file_id);
    QueueQueries.markFailed.run(msg, job.id);
    // Re-queue if attempts remain
    if (job.attempts < job.max_attempts - 1) QueueQueries.requeueFailed.run(job.id);
    // Clean up partial file
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
  }
}
