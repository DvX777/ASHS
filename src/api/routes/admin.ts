// src/api/routes/admin.ts
import { Elysia } from "elysia";
import { db, MediaQueries, QueueQueries, SiteQueries } from "../../db";
import { adminAuth } from "../middleware/auth";
import { generateApiKey } from "../../utils/hmac";
import { getMediaStats, getTempStats, formatDiskStats } from "../../storage/stats";
import { cleanTempDir } from "../../storage/cleanup";
import { Logger } from "../../utils/logger";
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

  // Remove content from library
  .delete("/media/:tmdbId", ({ params, query }: any) => {
    const type = query.type ?? "movie";
    MediaQueries.setStatus.run("removed", params.tmdbId, type);
    Logger.info(`[Admin] Removed: ${params.tmdbId} (${type})`);
    return { ok: true };
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
