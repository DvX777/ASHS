// src/api/routes/radarr.ts - Radarr Bridge & Webhooks
import { Elysia } from "elysia";
import path from "path";
import { Config } from "../../config";
import { db, MediaQueries } from "../../db";
import { RadarrClient } from "../../integrations/radarr";
import { Logger } from "../../utils/logger";
import { Discord } from "../../utils/discord";
import { eventBus } from "../../utils/eventBus";

function validateDashSession(req: Request): boolean {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return false;
  const m = cookieHeader.match(/ashs_session=([^;]+)/);
  if (!m) return false;
  const row = db.prepare("SELECT id FROM admin_sessions WHERE id=? AND expires_at > datetime('now')").get(m[1]);
  return !!row;
}

export const radarrRoutes = new Elysia({ prefix: "/0x/api/radarr" })

  // Webhook received from Radarr (On Download, On Upgrade, On Grab)
  .post("/webhook", async ({ body, set }: any) => {
    try {
      const eventType = body?.eventType;
      const movie = body?.movie;
      const movieFile = body?.movieFile;

      Logger.info(`[RadarrWebhook] Event: ${eventType} for ${movie?.title ?? "unknown"}`);

      if (eventType === "Download" || eventType === "Upgrade") {
        const tmdbId = String(movie?.tmdbId);
        const title = movie?.title ?? "Untitled";
        const year = movie?.year ?? null;
        const absPath = movieFile?.path;
        const size = movieFile?.size ?? 0;
        const qualityName = movieFile?.quality ?? "1080p";
        
        let res = 1080;
        if (/2160|4k/i.test(qualityName)) res = 2160;
        else if (/720/i.test(qualityName)) res = 720;
        else if (/480/i.test(qualityName)) res = 480;

        if (absPath && tmdbId) {
          const relPath = path.relative(Config.MEDIA_DIR, absPath).replace(/\\/g, "/");

          db.prepare(`
            INSERT INTO media (tmdb_id, type, title, year, status)
            VALUES (?, 'movie', ?, ?, 'ready')
            ON CONFLICT(tmdb_id, type) DO UPDATE SET
              title = excluded.title,
              year = COALESCE(media.year, excluded.year),
              status = 'ready',
              updated_at = datetime('now')
          `).run(tmdbId, title, year);

          const m = MediaQueries.findByTmdb.get(tmdbId, "movie");
          if (m) {
            db.prepare(`
              INSERT INTO media_files (media_id, season, episode, quality, language, format, file_path, file_size, status, completed_at, progress)
              VALUES (?, 0, 0, ?, 'Original', 'mkv', ?, ?, 'complete', datetime('now'), 1.0)
              ON CONFLICT(media_id, season, episode, quality) DO UPDATE SET
                file_path = excluded.file_path,
                file_size = excluded.file_size,
                status = 'complete',
                completed_at = datetime('now'),
                progress = 1.0
            `).run(m.id, res, relPath, size);

            Logger.info(`[RadarrWebhook] Successfully imported: ${title} (${res}p) -> ${relPath}`);
            
            eventBus.emit("download:complete", {
              jobId: m.id,
              title,
              quality: res,
              size,
            });

            await Discord.downloadDone(`[Radarr] ${title} (${res}p)`, size);
          }
        }
      }

      return { ok: true };
    } catch (err: any) {
      Logger.error(`[RadarrWebhook] Error: ${err.message}`);
      set.status = 500;
      return { error: err.message };
    }
  })

  .get("/status", async ({ request, set }: any) => {
    if (!validateDashSession(request)) { set.status = 401; return { error: "Unauthorized" }; }
    return await RadarrClient.getStatus();
  })

  .get("/queue", async ({ request, set }: any) => {
    if (!validateDashSession(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const queue = await RadarrClient.getQueue();
    return {
      activeCount: queue.length,
      maxSlots: Config.MAX_CONCURRENT_DOWNLOADS,
      records: queue.map((q: any) => ({
        id: q.id,
        title: q.title,
        status: q.status,
        trackedDownloadState: q.trackedDownloadState,
        size: q.size,
        sizeleft: q.sizeleft,
        timeleft: q.timeleft,
        estimatedCompletionTime: q.estimatedCompletionTime,
        downloadClient: q.downloadClient,
        indexer: q.indexer,
      })),
    };
  })

  .get("/search", async ({ request, query, set }: any) => {
    if (!validateDashSession(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const movieId = parseInt(query.movieId, 10);
    if (!movieId) { set.status = 400; return { error: "movieId required" }; }
    const releases = await RadarrClient.manualSearch(movieId);
    return { releases };
  })

  .post("/grab", async ({ request, body, set }: any) => {
    if (!validateDashSession(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { guid, indexerId } = body ?? {};
    if (!guid || !indexerId) { set.status = 400; return { error: "guid and indexerId required" }; }
    const ok = await RadarrClient.grabRelease(guid, indexerId);
    return { ok };
  })

  .get("/profiles", async ({ request, set }: any) => {
    if (!validateDashSession(request)) { set.status = 401; return { error: "Unauthorized" }; }
    return await RadarrClient.getQualityProfiles();
  });
