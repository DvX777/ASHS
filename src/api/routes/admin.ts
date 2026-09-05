// src/api/routes/admin.ts
import { Elysia } from "elysia";
import { db, MediaQueries, QueueQueries, SiteQueries } from "../../db";
import { adminAuth } from "../middleware/auth";
import { generateApiKey } from "../../utils/hmac";
import { getMediaStats, getTempStats, formatDiskStats } from "../../storage/stats";
import { cleanTempDir } from "../../storage/cleanup";
import { Logger } from "../../utils/logger";
import path from "path";
import fs from "fs";
import { Config } from "../../config";
import { runSRR, runSRRTargeted, getSRRRules, setSRRRule } from "../../ingestion/srr";
import { execSync } from "child_process";
import { eventBus } from "../../utils/eventBus";
import { randomUUID } from "crypto";

function createSession(ip: string, ua: string): string {
  const id = randomUUID();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO admin_sessions (id, expires_at, ip_address, user_agent) VALUES (?,?,?,?)").run(id, expires, ip, ua);
  return id;
}
function validateSession(sid: string): boolean {
  const row = db.prepare("SELECT id FROM admin_sessions WHERE id=? AND expires_at > datetime('now')").get(sid) as any;
  return !!row;
}
function getSessionFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/ashs_session=([^;]+)/);
  return m ? m[1] : null;
}
function dashAuth(req: Request): boolean {
  const sid = getSessionFromCookie(req.headers.get("cookie"));
  return sid ? validateSession(sid) : false;
}
export const adminRoutes = new Elysia({ prefix: "/v1/admin" })
  .use(adminAuth)
  .post("/download", async ({ body }: any) => {
    const { tmdb_id, type = "movie", priority = 10 } = body ?? {};
    if (!tmdb_id) return new Response(JSON.stringify({ error: "tmdb_id required" }), { status: 400 });
    const existing = MediaQueries.findByTmdb.get(tmdb_id, type);
    if (!existing) db.prepare("INSERT OR IGNORE INTO media (tmdb_id, type, title, status) VALUES (?, ?, ?, 'pending')").run(tmdb_id, type, tmdb_id);
    const m = MediaQueries.findByTmdb.get(tmdb_id, type)!;
    const job = QueueQueries.enqueue.get(m.id, null, priority);
    return { ok: true, queue_id: job?.id };
  })
  .get("/queue", ({ query }: any) => {
    const page = parseInt(query.page ?? "1", 10);
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 200);
    return { stats: QueueQueries.stats.all(), jobs: QueueQueries.list.all(limit, (page-1)*limit) };
  })
  .delete("/queue/:id", ({ params }: any) => { QueueQueries.cancel.run(parseInt(params.id, 10)); return { ok: true }; })
  .post("/sites", ({ body }: any) => {
    const { domain, name, rate_limit_rpm = 120 } = body ?? {};
    if (!domain) return new Response(JSON.stringify({ error: "domain required" }), { status: 400 });
    const apiKey = generateApiKey();
    const site = SiteQueries.insert.get(domain, apiKey, name ?? null, rate_limit_rpm);
    return { ok: true, id: site?.id, api_key: apiKey };
  })
  .delete("/sites/:id", ({ params }: any) => { SiteQueries.disable.run(parseInt(params.id, 10)); return { ok: true }; })
  .get("/sites", () => SiteQueries.list.all().map((s: any) => ({ id: s.id, domain: s.domain, name: s.name, rate_limit_rpm: s.rate_limit_rpm, enabled: !!s.enabled, api_key: s.api_key, created_at: s.created_at })))
  .delete("/media/:tmdbId", ({ params, query }: any) => {
    const type = query.type ?? "movie";
    const media = MediaQueries.findByTmdb.get(params.tmdbId, type);
    if (!media) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    const files = db.prepare("SELECT * FROM media_files WHERE media_id=?").all(media.id) as any[];
    let freed = 0;
    for (const f of files) {
      if (f.file_path) { try { const abs = path.join(Config.MEDIA_DIR, f.file_path); if (fs.existsSync(abs)) { freed += fs.statSync(abs).size; fs.unlinkSync(abs); } } catch {} }
    }
    db.prepare("UPDATE download_queue SET status='cancelled' WHERE media_id=? AND status IN ('queued','active')").run(media.id);
    MediaQueries.setStatus.run("removed", params.tmdbId, type);
    return { ok: true, freed_bytes: freed };
  })
  .post("/cleanup/temp", () => { cleanTempDir(); return { ok: true }; })
  .get("/logs", ({ query }: any) => db.prepare("SELECT * FROM access_logs ORDER BY created_at DESC LIMIT ?").all(Math.min(parseInt(query.limit ?? "100"), 500)))
  .post("/ingest", () => { try { require("fs").writeFileSync("/tmp/ashs_ingest_trigger", Date.now().toString()); } catch {} return { ok: true }; })
  .post("/refresh-meta", ({ set }: any) => {
    (async () => {
      const stale = db.prepare("SELECT id, tmdb_id, type FROM media WHERE status IN ('ready','downloading') AND (poster_path IS NULL OR overview IS NULL) ORDER BY popularity DESC LIMIT 300").all() as any[];
      let updated = 0;
      for (const m of stale) {
        try {
          const url = m.type === "tv" ? `https://api.themoviedb.org/3/tv/${m.tmdb_id}?api_key=${Config.TMDB_API_KEY}` : `https://api.themoviedb.org/3/movie/${m.tmdb_id}?api_key=${Config.TMDB_API_KEY}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const d: any = await res.json();
          db.prepare("UPDATE media SET poster_path=COALESCE(poster_path,?), overview=COALESCE(overview,?), updated_at=datetime('now') WHERE id=?").run(d.poster_path ?? null, d.overview ?? null, m.id);
          updated++; await new Promise(r => setTimeout(r, 250));
        } catch {}
      }
      Logger.info("[Admin] refresh-meta: " + updated);
    })().catch(() => {});
    return { ok: true };
  })
  .get("/health", () => {
    const media = getMediaStats(); const temp = getTempStats();
    const qMap = Object.fromEntries((QueueQueries.stats.all() as any[]).map((r: any) => [r.status, r.count]));
    const libMap = Object.fromEntries((db.prepare("SELECT type, COUNT(*) as c FROM media WHERE status='ready' GROUP BY type").all() as any[]).map((r: any) => [r.type, r.c]));
    const files = (db.prepare("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").get() as any).c;
    const bytes = (db.prepare("SELECT COALESCE(SUM(file_size),0) as s FROM media_files WHERE status='complete'").get() as any).s;
    let tunnel = "unknown";
    try { tunnel = execSync("systemctl is-active cloudflared 2>/dev/null", { timeout: 2000 }).toString().trim(); } catch {}
    return {
      status: tunnel === "active" ? "ok" : "degraded",
      uptime_seconds: Math.floor(process.uptime()),
      tunnel: tunnel === "active" ? "connected" : "disconnected",
      memory: process.memoryUsage(),
      storage: { hdd: { ...media, summary: formatDiskStats(media) }, nvme: { ...temp, summary: formatDiskStats(temp) } },
      library: { movies: libMap.movie ?? 0, tv_shows: libMap.tv ?? 0, total_files: files, total_bytes: bytes, failed_media: (db.prepare("SELECT COUNT(*) as c FROM media WHERE status='failed'").get() as any).c },
      queue: { pending: qMap.queued ?? 0, active: qMap.active ?? 0, done: qMap.done ?? 0, failed: qMap.failed ?? 0 },
    };
  })
  .post("/srr", async () => { runSRR().catch(() => {}); return { ok: true }; });
export const dashboardApiRoutes = new Elysia({ prefix: "/0x/api" })

  .post("/auth/login", ({ body, request, set }: any) => {
    const { key } = body ?? {};
    if (!key || key !== Config.ADMIN_API_KEY) { set.status = 401; return { error: "Invalid admin key" }; }
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ua = request.headers.get("user-agent") ?? "";
    const sid = createSession(ip, ua);
    set.headers["Set-Cookie"] = `ashs_session=${sid}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`;
    return { ok: true };
  })

  .post("/auth/logout", ({ set, request }: any) => {
    const sid = getSessionFromCookie(request.headers.get("cookie"));
    if (sid) db.prepare("DELETE FROM admin_sessions WHERE id=?").run(sid);
    set.headers["Set-Cookie"] = "ashs_session=; HttpOnly; Path=/; Max-Age=0";
    return { ok: true };
  })

  .get("/auth/check", ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Not authenticated" }; }
    return { ok: true };
  })

  .get("/events", ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    let unsub: (() => void) | null = null;
    const stream = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder();
        const send = (type: string, data: any) => {
          try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type, data })}\n\n`)); } catch {}
        };
        const hb = setInterval(() => {
          try { ctrl.enqueue(enc.encode(": heartbeat\n\n")); } catch { clearInterval(hb); }
        }, 25000);
        const qStats = QueueQueries.stats.all() as any[];
        const qMap = Object.fromEntries(qStats.map((r: any) => [r.status, r.count]));
        send("queue:stats", { active: qMap.active ?? 0, pending: qMap.queued ?? 0, failed: qMap.failed ?? 0, done: qMap.done ?? 0 });
        unsub = eventBus.subscribe((type, data) => send(type, data));
      },
      cancel() { unsub?.(); },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  })

  .get("/system/stats", ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const media = getMediaStats(); const temp = getTempStats();
    const qMap = Object.fromEntries((QueueQueries.stats.all() as any[]).map((r: any) => [r.status, r.count]));
    const libMap = Object.fromEntries((db.prepare("SELECT type, COUNT(*) as c FROM media WHERE status='ready' GROUP BY type").all() as any[]).map((r: any) => [r.type, r.c]));
    const files = (db.prepare("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").get() as any).c;
    const bytes = (db.prepare("SELECT COALESCE(SUM(file_size),0) as s FROM media_files WHERE status='complete'").get() as any).s;
    let tunnel = "unknown";
    try { tunnel = execSync("systemctl is-active cloudflared 2>/dev/null", { timeout: 2000 }).toString().trim() === "active" ? "connected" : "disconnected"; } catch {}
    return {
      uptime_seconds: Math.floor(process.uptime()), tunnel, memory: process.memoryUsage(),
      storage: { hdd: { total_bytes: media.total, used_bytes: media.used, free_bytes: media.free }, nvme: { total_bytes: temp.total, used_bytes: temp.used, free_bytes: temp.free } },
      library: { movies: libMap.movie ?? 0, tv_shows: libMap.tv ?? 0, total_files: files, total_bytes: bytes },
      queue: { active: qMap.active ?? 0, pending: qMap.queued ?? 0, failed: qMap.failed ?? 0, done: qMap.done ?? 0 },
    };
  })

  .get("/system/logs", ({ request, query, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const type = query.type ?? "out";
    const lines = Math.min(parseInt(query.lines ?? "200"), 1000);
    if (type === "access") {
      return { items: db.prepare("SELECT * FROM access_logs ORDER BY created_at DESC LIMIT ?").all(lines) };
    }
    const logFile = type === "error" ? "/var/log/ashs/error.log" : "/var/log/ashs/out.log";
    try { return { lines: execSync(`tail -n ${lines} "${logFile}" 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).split("\n").filter(Boolean) }; }
    catch { return { lines: [] }; }
  })

  .post("/system/ingest",       ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { fs.writeFileSync("/tmp/ashs_ingest_trigger", Date.now().toString()); } catch {} return { ok: true }; })
  .post("/system/cleanup-temp", ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } cleanTempDir(); return { ok: true }; })
  .post("/system/refresh-meta", ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } return { ok: true }; })
  .post("/system/reset-failed", ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const r = db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE status='failed'").run(); return { ok: true, count: r.changes }; })
  .post("/system/purge-logs",   ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } db.prepare("DELETE FROM access_logs").run(); return { ok: true }; })

  .get("/media", ({ request, query, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { status, type, q, page = "1", limit = "50", sort = "updated_at" } = query;
    const p = Math.max(1, parseInt(page)); const lim = Math.min(200, parseInt(limit)); const offset = (p-1)*lim;
    let where = "WHERE 1=1"; const args: any[] = [];
    if (status) { where += " AND m.status IN ("+status.split(",").map(()=>"?").join(",")+")"; args.push(...status.split(",")); }
    if (type)   { where += " AND m.type=?"; args.push(type); }
    if (q)      { where += " AND m.title LIKE ?"; args.push("%"+q+"%"); }
    const sortCol = ({ popularity: "popularity DESC", updated_at: "updated_at DESC", title: "title ASC", year: "year DESC" } as any)[sort] ?? "updated_at DESC";
    const items = db.prepare(`SELECT m.*, (SELECT GROUP_CONCAT(DISTINCT f.quality) FROM media_files f WHERE f.media_id=m.id AND f.status='complete') as qualities, (SELECT COALESCE(SUM(f.file_size),0) FROM media_files f WHERE f.media_id=m.id) as total_size FROM media m ${where} ORDER BY ${sortCol} LIMIT ? OFFSET ?`).all(...args, lim, offset) as any[];
    const total = (db.prepare(`SELECT COUNT(*) as c FROM media m ${where}`).get(...args) as any)?.c ?? 0;
    return { items, total, page: p, limit: lim };
  })

  .get("/media/:id", ({ request, params, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const media = db.prepare("SELECT * FROM media WHERE id=?").get(parseInt(params.id)) as any;
    if (!media) { set.status = 404; return { error: "Not found" }; }
    return { ...media, files: db.prepare("SELECT * FROM media_files WHERE media_id=? ORDER BY quality DESC, season, episode").all(media.id), jobs: db.prepare("SELECT * FROM download_queue WHERE media_id=? ORDER BY id DESC LIMIT 20").all(media.id) };
  })

  .patch("/media/:id/status", ({ request, params, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    db.prepare("UPDATE media SET status=?, updated_at=datetime('now') WHERE id=?").run(body?.status, parseInt(params.id));
    return { ok: true };
  })

  .post("/media/:id/retry", ({ request, params, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const id = parseInt(params.id);
    db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE id=?").run(id);
    db.prepare("UPDATE media_files SET status='queued', error=NULL WHERE media_id=? AND status='failed'").run(id);
    db.prepare("UPDATE download_queue SET status='queued', attempts=0, scheduled_at=datetime('now') WHERE media_id=? AND status='failed'").run(id);
    return { ok: true };
  })

  .delete("/media/:id", ({ request, params, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const id = parseInt(params.id);
    const media = db.prepare("SELECT * FROM media WHERE id=?").get(id) as any;
    if (!media) { set.status = 404; return { error: "Not found" }; }
    const files = db.prepare("SELECT * FROM media_files WHERE media_id=?").all(id) as any[];
    let freed = 0;
    for (const f of files) { if (f.file_path) { try { const abs = path.join(Config.MEDIA_DIR, f.file_path); if (fs.existsSync(abs)) { freed += fs.statSync(abs).size; fs.unlinkSync(abs); } } catch {} } }
    db.prepare("UPDATE download_queue SET status='cancelled' WHERE media_id=? AND status IN ('queued','active')").run(id);
    db.prepare("UPDATE media SET status='removed', updated_at=datetime('now') WHERE id=?").run(id);
    return { ok: true, freed_bytes: freed };
  })

  .post("/media/bulk", ({ request, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { ids, action } = body ?? {};
    if (!ids?.length) return { ok: true, count: 0 };
    const ph = ids.map(()=>"?").join(",");
    if (action === "mark-ready") db.prepare(`UPDATE media SET status='ready', updated_at=datetime('now') WHERE id IN (${ph})`).run(...ids);
    else if (action === "retry") db.prepare(`UPDATE media SET status='pending', updated_at=datetime('now') WHERE id IN (${ph})`).run(...ids);
    else if (action === "remove") db.prepare(`UPDATE media SET status='removed', updated_at=datetime('now') WHERE id IN (${ph})`).run(...ids);
    return { ok: true, count: ids.length };
  })
  .get("/queue", ({ request, query, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { status, page = "1", limit = "50" } = query;
    const p = Math.max(1, parseInt(page)); const lim = Math.min(200, parseInt(limit));
    const where = status ? `WHERE q.status='${status.replace(/[^a-z]/g,"")}'` : "";
    const jobs = db.prepare(`SELECT q.*, m.title, m.type, f.quality, f.season, f.episode, f.language FROM download_queue q JOIN media m ON m.id=q.media_id LEFT JOIN media_files f ON f.id=q.media_file_id ${where} ORDER BY q.priority ASC, q.scheduled_at ASC LIMIT ? OFFSET ?`).all(lim, (p-1)*lim);
    return { jobs };
  })
  .post("/queue/:id/retry",  ({ request, params, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } db.prepare("UPDATE download_queue SET status='queued', attempts=0, scheduled_at=datetime('now') WHERE id=?").run(parseInt(params.id)); return { ok: true }; })
  .post("/queue/:id/cancel", ({ request, params, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } db.prepare("UPDATE download_queue SET status='cancelled' WHERE id=? AND status IN ('queued','pending')").run(parseInt(params.id)); return { ok: true }; })
  .post("/queue/retry-all-failed", ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const r = db.prepare("UPDATE download_queue SET status='queued', attempts=0, scheduled_at=datetime('now') WHERE status='failed'").run(); return { ok: true, count: r.changes }; })
  .post("/queue/cancel-all",       ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const r = db.prepare("UPDATE download_queue SET status='cancelled' WHERE status IN ('queued','pending')").run(); return { ok: true, count: r.changes }; })
  .post("/queue/pause",  ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { fs.writeFileSync("/tmp/ashs_queue_paused","1"); } catch {} return { ok: true }; })
  .post("/queue/resume", ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { fs.unlinkSync("/tmp/ashs_queue_paused"); } catch {} return { ok: true }; })

  .get("/healer/scan", ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    return { issues: [
      { type: "stuck-downloading",  label: "Stuck Downloading",   description: "Media 'downloading' with all files complete",              fix_preview: "Mark as ready",         count: (db.prepare("SELECT COUNT(*) as c FROM media m WHERE m.status='downloading' AND NOT EXISTS (SELECT 1 FROM media_files f WHERE f.media_id=m.id AND f.status!='complete')").get() as any).c },
      { type: "exhausted-queue",    label: "Exhausted Queue",     description: "Queue items at max_attempts Ã¢â‚¬â€ stuck forever",             fix_preview: "Reset attempts to 0",    count: (db.prepare("SELECT COUNT(*) as c FROM download_queue WHERE status='queued' AND attempts>=max_attempts").get() as any).c },
      { type: "ghost-pending-queue",label: "Ghost Pending Queue", description: "Queue entries stuck as 'pending' (invisible to scheduler)", fix_preview: "Convert to queued",     count: (db.prepare("SELECT COUNT(*) as c FROM download_queue WHERE status='pending'").get() as any).c },
      { type: "stale-resolving",    label: "Stale Resolving",     description: "Media stuck 'resolving' for over 1 hour",                 fix_preview: "Reset to pending",       count: (db.prepare("SELECT COUNT(*) as c FROM media WHERE status='resolving' AND updated_at < datetime('now','-1 hour')").get() as any).c },
      { type: "failed-media",       label: "Failed Media",        description: "Media in 'failed' state ready for retry",                 fix_preview: "Reset to pending",       count: (db.prepare("SELECT COUNT(*) as c FROM media WHERE status='failed'").get() as any).c },
      { type: "orphan-temp",        label: "Orphan Temp Files",   description: ".part temp files with no active download job",            fix_preview: "Delete from NVMe",       count: (() => { try { return fs.readdirSync(Config.TEMP_DIR).filter(f=>f.endsWith(".part")).length; } catch { return 0; } })() },
    ]};
  })

  .post("/healer/fix", ({ request, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { type } = body ?? {};
    let fixed = 0;
    const fix = (t: string) => {
      if (t === "stuck-downloading")   fixed += db.prepare("UPDATE media SET status='ready', updated_at=datetime('now') WHERE status='downloading' AND id NOT IN (SELECT DISTINCT media_id FROM media_files WHERE status!='complete')").run().changes;
      if (t === "exhausted-queue")     fixed += db.prepare("UPDATE download_queue SET attempts=0, scheduled_at=datetime('now') WHERE status='queued' AND attempts>=max_attempts").run().changes;
      if (t === "ghost-pending-queue") fixed += db.prepare("UPDATE download_queue SET status='queued', scheduled_at=datetime('now') WHERE status='pending'").run().changes;
      if (t === "stale-resolving")     fixed += db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE status='resolving' AND updated_at < datetime('now','-1 hour')").run().changes;
      if (t === "failed-media")        fixed += db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE status='failed'").run().changes;
      if (t === "orphan-temp") { try { for (const p of fs.readdirSync(Config.TEMP_DIR).filter(f=>f.endsWith(".part"))) { try { fs.unlinkSync(path.join(Config.TEMP_DIR,p)); fixed++; } catch {} } } catch {} }
    };
    if (type === "all") ["stuck-downloading","exhausted-queue","ghost-pending-queue","stale-resolving","failed-media","orphan-temp"].forEach(fix);
    else fix(type);
    Logger.info(`[Healer] Fixed ${fixed} (type: ${type})`);
    return { ok: true, fixed };
  })

  .get("/healer/history", ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    return { items: db.prepare("SELECT * FROM srr_history ORDER BY started_at DESC LIMIT 50").all() };
  })

  .get("/srr/status",    ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const last = db.prepare("SELECT * FROM srr_history ORDER BY started_at DESC LIMIT 1").get() as any; return { status: "idle", lastRun: last?.started_at ?? null, lastResult: last ? { found: last.issues_found, fixed: last.issues_fixed } : null }; })
  .get("/srr/rules",     ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { return getSRRRules(); } catch { return []; } })
  .patch("/srr/rules/:ruleId", ({ request, params, body, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { setSRRRule(params.ruleId, body); } catch {} return { ok: true }; })
  .post("/srr/run",      ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } runSRR().catch(()=>{}); return { ok: true }; })
  .post("/srr/run-targeted", ({ request, body, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } try { runSRRTargeted(body?.mediaIds??[], body?.rules??["all"]).catch(()=>{}); } catch {} return { ok: true }; })
  .get("/srr/history",   ({ request, query, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const p = Math.max(1, parseInt(query.page??"1")); return { items: db.prepare("SELECT * FROM srr_history ORDER BY started_at DESC LIMIT 20 OFFSET ?").all((p-1)*20), page: p }; })
  .get("/srr/history/:id", ({ request, params, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const row = db.prepare("SELECT * FROM srr_history WHERE id=?").get(parseInt(params.id)); if (!row) { set.status=404; return { error:"Not found" }; } return row; })
  .post("/srr/resolve",  ({ request, body, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const { mediaId } = body??{}; db.prepare("UPDATE media SET status='pending', moviebox_id=NULL, updated_at=datetime('now') WHERE id=?").run(mediaId); db.prepare("UPDATE media_files SET status='queued', error=NULL WHERE media_id=?").run(mediaId); return { ok: true }; })
  .post("/srr/requeue",  ({ request, body, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const { mediaId } = body??{}; db.prepare("UPDATE download_queue SET status='queued', attempts=0, scheduled_at=datetime('now') WHERE media_id=? AND status IN ('failed','cancelled','pending')").run(mediaId); db.prepare("UPDATE media SET status='downloading', updated_at=datetime('now') WHERE id=? AND status NOT IN ('ready')").run(mediaId); return { ok: true }; })
  .get("/srr/schedule",  ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } return { interval: "6h", runOnStartup: true }; })
  .patch("/srr/schedule",({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } return { ok: true }; })

  .get("/sites",    ({ request, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } return SiteQueries.list.all().map((s:any) => ({ id:s.id, domain:s.domain, name:s.name, api_key:s.api_key, rate_limit_rpm:s.rate_limit_rpm, enabled:!!s.enabled, created_at:s.created_at })); })
  .post("/sites",   ({ request, body, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } const { domain, name, rate_limit_rpm=120 } = body??{}; if (!domain) { set.status=400; return { error:"domain required" }; } const apiKey=generateApiKey(); SiteQueries.insert.get(domain, apiKey, name??null, rate_limit_rpm); return { ok:true, api_key:apiKey }; })
  .delete("/sites/:id", ({ request, params, set }: any) => { if (!dashAuth(request)) { set.status=401; return { error:"Unauthorized" }; } SiteQueries.disable.run(parseInt(params.id)); return { ok:true }; })

  .post("/upload/search-tmdb", async ({ request, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { q, type } = body ?? {};
    const url = type === "tv"
      ? `https://api.themoviedb.org/3/search/tv?api_key=${Config.TMDB_API_KEY}&query=${encodeURIComponent(q)}`
      : `https://api.themoviedb.org/3/search/movie?api_key=${Config.TMDB_API_KEY}&query=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data: any = await res.json();
    return { results: (data.results ?? []).slice(0,10).map((r:any) => ({ id:r.id, title:r.title??r.name, poster_path:r.poster_path, release_date:r.release_date, first_air_date:r.first_air_date, vote_average:r.vote_average, overview:r.overview })) };
  })

  .post("/upload/init", ({ request, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { tmdb_id, type, quality, season=0, episode=0 } = body ?? {};
    db.prepare("INSERT OR IGNORE INTO media (tmdb_id, type, title, status) VALUES (?,?,?,?)").run(String(tmdb_id), type, String(tmdb_id), "downloading");
    const m = MediaQueries.findByTmdb.get(String(tmdb_id), type)!;
    const file = db.prepare("INSERT OR IGNORE INTO media_files (media_id, season, episode, quality, language, format, status) VALUES (?,?,?,?,'Original','mp4','downloading') RETURNING id").get(m.id, season, episode, quality) as any;
    return { ok: true, id: file?.id ?? 0, media_id: m.id };
  })

  .post("/upload/chunk", async ({ request, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const form = await request.formData();
    const id = parseInt(form.get("id")); const offset = parseInt(form.get("offset")??"0"); const chunk = form.get("chunk") as File;
    if (!chunk) { set.status=400; return { error:"no chunk" }; }
    const dest = path.join(Config.MEDIA_DIR, `upload_${id}.tmp`);
    const buf = Buffer.from(await chunk.arrayBuffer());
    const fd = fs.openSync(dest, offset===0 ? "w" : "r+");
    fs.writeSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd);
    return { ok: true };
  })

  .post("/upload/complete", ({ request, body, set }: any) => {
    if (!dashAuth(request)) { set.status = 401; return { error: "Unauthorized" }; }
    const { id } = body ?? {};
    const file = db.prepare("SELECT * FROM media_files WHERE id=?").get(id) as any;
    if (!file) { set.status=404; return { error:"Not found" }; }
    const tmpPath = path.join(Config.MEDIA_DIR, `upload_${id}.tmp`);
    const finalRel = file.season > 0
      ? `tv/${file.media_id}/s${String(file.season).padStart(2,"0")}e${String(file.episode).padStart(2,"0")}_${file.quality}p.mp4`
      : `movie/${file.media_id}/${file.quality}p.mp4`;
    const finalAbs = path.join(Config.MEDIA_DIR, finalRel);
    fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
    fs.renameSync(tmpPath, finalAbs);
    const size = fs.statSync(finalAbs).size;
    db.prepare("UPDATE media_files SET status='complete', file_path=?, file_size=?, completed_at=datetime('now'), progress=1.0 WHERE id=?").run(finalRel, size, id);
    db.prepare("UPDATE media SET status='ready', updated_at=datetime('now') WHERE id=?").run(file.media_id);
    return { ok: true };
  });