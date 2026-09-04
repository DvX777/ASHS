// src/api/routes/admin.ts
import { Elysia } from "elysia";
import { db, MediaQueries, QueueQueries, SiteQueries } from "../../db";
import { adminAuth } from "../middleware/auth";
import { generateApiKey } from "../../utils/hmac";
import { getMediaStats, getTempStats } from "../../storage/stats";
import { cleanTempDir } from "../../storage/cleanup";
import { Logger } from "../../utils/logger";

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
  });
