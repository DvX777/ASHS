// src/api/routes/admin.ts
import { Elysia } from "elysia";
import { db, MediaQueries, QueueQueries, SiteQueries } from "../../db";
import { adminAuth } from "../middleware/auth";
import { generateApiKey } from "../../utils/hmac";
import { getMediaStats, getTempStats, formatDiskStats } from "../../storage/stats";
import { cleanTempDir } from "../../storage/cleanup";
import { Logger } from "../../utils/logger";
import { db as _db } from "../../db";
import path from "path";
import fs from "fs";
import { Config } from "../../config";
import { runSRR } from "../../ingestion/srr";
import { execSync } from "child_process";

export const adminRoutes = new Elysia({ prefix: "/v1/admin" })
  .use(adminAuth)

  // Queue a specific title for download
  .post("/download", async ({ body }: any) => {
    const { tmdb_id, type = "movie", season = 0, episode = 0, priority = 10 } = body ?? {};
    if (!tmdb_id) return new Response(JSON.stringify({ error: "tmdb_id required" }), { status: 400 });
    const existing = MediaQueries.findByTmdb.get(tmdb_id, type);
    if (!existing) {
      db.prepare("INSERT OR IGNORE INTO media (tmdb_id, type, title, status) VALUES (?, ?, ?, 'pending')").run(tmdb_id, type, tmdb_id);
    }
    const m = MediaQueries.findByTmdb.get(tmdb_id, type)!;
    const job = QueueQueries.enqueue.get(m.id, null, priority);
    Logger.info(`[Admin] Queued download: ${tmdb_id} (${type}) S${season}E${episode}`);
    return { ok: true, queue_id: job?.id };
  })

  // View download queue
  .get("/queue", ({ query }: any) => {
    const page  = parseInt(query.page ?? "1", 10);
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    const jobs  = QueueQueries.list.all(limit, (page-1)*limit);
    const stats = QueueQueries.stats.all();
    return { stats, jobs };
  })

  // Cancel a queued job
  .delete("/queue/:id", ({ params }: any) => {
    QueueQueries.cancel.run(parseInt(params.id, 10));
    return { ok: true };
  })

  // Add approved site
  .post("/sites", ({ body }: any) => {
    const { domain, name, rate_limit_rpm = 120 } = body ?? {};
    if (!domain) return new Response(JSON.stringify({ error: "domain required" }), { status: 400 });
    const apiKey = generateApiKey();
    const site = SiteQueries.insert.get(domain, apiKey, name ?? null, rate_limit_rpm);
    return { ok: true, id: site?.id, domain, api_key: apiKey };
  })

  // Revoke site access
  .delete("/sites/:id", ({ params }: any) => {
    SiteQueries.disable.run(parseInt(params.id, 10));
    return { ok: true };
  })

  // List sites
  .get("/sites", () => SiteQueries.list.all().map(s => ({
    id: s.id, domain: s.domain, name: s.name,
    rate_limit_rpm: s.rate_limit_rpm, enabled: !!s.enabled, created_at: s.created_at,
  })))

  // Trigger immediate TMDB metadata refresh for ready movies with missing metadata
  .post("/refresh-meta", async ({ set }: any) => {
    // Run in background
    (async () => {
      const stale = db.prepare(
        "SELECT id, tmdb_id, type FROM media WHERE status IN ('ready','downloading') AND (poster_path IS NULL OR overview IS NULL) ORDER BY popularity DESC LIMIT 300"
      ).all() as any[];
      let updated = 0;
      for (const m of stale) {
        const ep = m.type === "tv"
          ? `https://api.themoviedb.org/3/tv/${m.tmdb_id}?api_key=${Config.TMDB_API_KEY}`
          : `https://api.themoviedb.org/3/movie/${m.tmdb_id}?api_key=${Config.TMDB_API_KEY}`;
        try {
          const res = await fetch(ep, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const d: any = await res.json();
          db.prepare(
            "UPDATE media SET poster_path=COALESCE(poster_path,?), backdrop_path=COALESCE(backdrop_path,?), overview=COALESCE(overview,?), genres=COALESCE(genres,?), runtime=COALESCE(NULLIF(runtime,0),?), updated_at=datetime('now') WHERE id=?"
          ).run(
            d.poster_path ?? null,
            d.backdrop_path ?? null,
            d.overview ?? null,
            d.genres?.length ? JSON.stringify(d.genres.map((g: any) => g.name)) : null,
            d.runtime ?? d.episode_run_time?.[0] ?? null,
            m.id
          );
          updated++;
          await new Promise(r => setTimeout(r, 250));
        } catch {}
      }
      Logger.info("[Admin] refresh-meta: updated " + updated + "/" + stale.length + " records");
    })().catch(e => Logger.error("[Admin] refresh-meta error: " + e.message));

    return { ok: true, message: "Metadata refresh started in background for up to 300 titles" };
  })

  // Remove content from library (marks DB + deletes files from disk)
  .delete("/media/:tmdbId", ({ params, query }: any) => {
    const type = query.type ?? "movie";
    const media = MediaQueries.findByTmdb.get(params.tmdbId, type);
    if (!media) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

    // Find all completed files and delete from disk
    const files = db.prepare("SELECT * FROM media_files WHERE media_id=?").all(media.id) as any[];
    let deletedFiles = 0;
    let freedBytes   = 0;

    for (const f of files) {
      if (f.file_path) {
        const abs = path.join(Config.MEDIA_DIR, f.file_path);
        try {
          if (fs.existsSync(abs)) {
            const size = fs.statSync(abs).size;
            fs.unlinkSync(abs);
            freedBytes += size;
            deletedFiles++;
          }
        } catch (e) {
          Logger.warn("[Admin] Could not delete file: " + abs);
        }
      }
      // Also remove any .part temp files
      try {
        const tempFiles = fs.readdirSync(Config.TEMP_DIR).filter(t => t.includes("dl_") && t.endsWith(".part"));
        for (const t of tempFiles) fs.unlinkSync(path.join(Config.TEMP_DIR, t));
      } catch {}
    }

    // Cancel queued/active jobs for this media
    db.prepare("UPDATE download_queue SET status='cancelled' WHERE media_id=? AND status IN ('queued','active')").run(media.id);

    // Mark media as removed
    MediaQueries.setStatus.run("removed", params.tmdbId, type);

    const freed = freedBytes > 1e9 ? (freedBytes/1e9).toFixed(2)+" GB" : (freedBytes/1e6).toFixed(0)+" MB";
    Logger.info("[Admin] Removed: " + params.tmdbId + " (" + type + ") — " + deletedFiles + " files, " + freed + " freed");
    return { ok: true, deleted_files: deletedFiles, freed_bytes: freedBytes, freed };
  })

  // Clean temp dir manually
  .post("/cleanup/temp", () => { cleanTempDir(); return { ok: true }; })

  // Recent access logs
  .get("/logs", ({ query }: any) => {
    const limit = Math.min(parseInt(query.limit ?? "100", 10), 500);
    return db.prepare("SELECT * FROM access_logs ORDER BY created_at DESC LIMIT ?").all(limit);
  })

  // Trigger ingestion manually (signal the scheduler)
  .post("/ingest", () => {
    // Write a trigger file — the scheduler polls for this
    require("fs").writeFileSync("/tmp/ashs_ingest_trigger", Date.now().toString());
    return { ok: true, message: "Ingestion triggered" };
  })

  // Full system health (detailed)
  .get("/health", () => {
    const media  = getMediaStats();
    const temp   = getTempStats();
    const qStats = QueueQueries.stats.all() as any[];
    const qMap   = Object.fromEntries(qStats.map((r: any) => [r.status, r.count]));
    const lib    = db.prepare("SELECT type, COUNT(*) as c FROM media WHERE status='ready' GROUP BY type").all() as any[];
    const libMap = Object.fromEntries(lib.map((r: any) => [r.type, r.c]));
    const files  = (db.prepare("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").get() as any).c;
    const bytes  = (db.prepare("SELECT COALESCE(SUM(file_size),0) as s FROM media_files WHERE status='complete'").get() as any).s;
    const failing = db.prepare("SELECT COUNT(*) as c FROM media WHERE status='failed'").get() as any;
    const unavail = db.prepare("SELECT COUNT(*) as c FROM media WHERE status='unavailable'").get() as any;
    const sites  = db.prepare("SELECT COUNT(*) as c FROM approved_sites WHERE enabled=1").get() as any;

    let tunnelStatus = "unknown";
    try { tunnelStatus = execSync("systemctl is-active cloudflared 2>/dev/null", { timeout: 2000 }).toString().trim(); } catch {}

    return {
      status: tunnelStatus === "active" ? "ok" : "degraded",
      uptime_seconds: Math.floor(process.uptime()),
      tunnel: tunnelStatus === "active" ? "connected" : "disconnected",
      memory: process.memoryUsage(),
      storage: {
        hdd:  { ...media,  summary: formatDiskStats(media) },
        nvme: { ...temp,   summary: formatDiskStats(temp)  },
      },
      library: {
        movies:      libMap.movie  ?? 0,
        tv_shows:    libMap.tv     ?? 0,
        total_files: files,
        total_bytes: bytes,
        failed_media: failing.c,
        unavailable_on_moviebox: unavail.c,
      },
      queue: {
        pending:  qMap.queued    ?? 0,
        active:   qMap.active    ?? 0,
        done:     qMap.done      ?? 0,
        failed:   qMap.failed    ?? 0,
        cancelled: qMap.cancelled ?? 0,
      },
      sites: { approved: sites.c },
    };
  })

  // Trigger Smart Re-Resolve manually
  .post("/srr", async () => {
    runSRR().catch(err => Logger.error("[SRR] Manual trigger failed: " + err.message));
    return { ok: true, message: "Smart Re-Resolve started in background" };
  });
