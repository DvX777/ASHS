// src/api/app.ts
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { Config } from "../config";
import { db, QueueQueries } from "../db";
import { logAccess } from "../api/middleware/accessLog";
import { getMediaStats, getTempStats, formatDiskStats } from "../storage/stats";
import { libraryRoutes } from "./routes/library";
import { adminRoutes, dashboardApiRoutes } from "./routes/admin";
import { radarrRoutes } from "./routes/radarr";
import { createFileApp } from "../fileserver/app";

function getTunnelStatus(): "connected" | "disconnected" | "unknown" {
  try {
    const out = execSync("systemctl is-active cloudflared 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
    return out === "active" ? "connected" : "disconnected";
  } catch { return "unknown"; }
}

// Serve static admin dashboard files
function serveAdmin(filePath: string): Response {
  const distDir = path.join(import.meta.dir, "../admin/dashboard/dist");
  const abs = path.join(distDir, filePath);
  const mimeTypes: Record<string, string> = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const ext = path.extname(abs).toLowerCase();
    const contentType = mimeTypes[ext] || "application/octet-stream";
    return new Response(Bun.file(abs), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
  // SPA fallback - NEVER cache index.html
  return new Response(Bun.file(path.join(distDir, "index.html")), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

export function createApiApp() {
  return new Elysia()
    .use(cors({ origin: Config.CORS_ORIGINS.includes("*") ? true : Config.CORS_ORIGINS }))
    .onAfterHandle(({ request, set }: any) => { logAccess(request, set); })

    // Public health endpoint
    .get("/health", () => {
      const media  = getMediaStats();
      const temp   = getTempStats();
      const qStats = QueueQueries.stats.all();
      const qMap   = Object.fromEntries(qStats.map((r: any) => [r.status, r.count]));
      const lib    = db.prepare("SELECT type, COUNT(*) as c FROM media WHERE status='ready' GROUP BY type").all() as any[];
      const libMap = Object.fromEntries(lib.map((r: any) => [r.type, r.c]));
      return {
        status: "ok",
        uptime_seconds: Math.floor(process.uptime()),
        storage: {
          hdd:  { total_bytes: media.total, used_bytes: media.used, free_bytes: media.free, summary: formatDiskStats(media) },
          nvme: { total_bytes: temp.total,  used_bytes: temp.used,  free_bytes: temp.free,  summary: formatDiskStats(temp) },
        },
        library: {
          movies:      libMap.movie ?? 0,
          tv_shows:    libMap.tv ?? 0,
          total_files: (db.prepare("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").get() as any)?.c ?? 0,
        },
        queue: { pending: qMap.queued ?? 0, active: qMap.active ?? 0, failed: qMap.failed ?? 0, done_total: qMap.done ?? 0 },
        tunnel: getTunnelStatus(),
        memory: process.memoryUsage(),
      };
    })

    // Library + admin API routes
    .use(libraryRoutes)
    .use(adminRoutes)

    // Dashboard REST API routes (/0x/api/*)
    .use(dashboardApiRoutes)
    .use(radarrRoutes)

    // Admin dashboard static files at /0x/*
    .get("/0x", () => serveAdmin("index.html"))
    .get("/0x/", () => serveAdmin("index.html"))
    .get("/0x/assets/*", ({ params }: any) => serveAdmin("assets/" + params["*"]))
    .get("/0x/*", () => serveAdmin("index.html"))

    // File streaming
    .use(createFileApp())

    .all("*", ({ set }: any) => { set.status = 404; return { error: "Not found" }; });
}