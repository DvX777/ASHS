// src/api/app.ts
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { execSync } from "child_process";
import { Config } from "../config";
import { db, QueueQueries } from "../db";
import { getMediaStats, getTempStats, formatDiskStats } from "../storage/stats";
import { libraryRoutes } from "./routes/library";
import { adminRoutes } from "./routes/admin";

function getTunnelStatus(): "connected" | "disconnected" | "unknown" {
  try {
    const out = execSync("systemctl is-active cloudflared 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
    return out === "active" ? "connected" : "disconnected";
  } catch {
    return "unknown";
  }
}

export function createApiApp() {
  return new Elysia()
    .use(cors({ origin: Config.CORS_ORIGINS.includes("*") ? true : Config.CORS_ORIGINS }))
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
    .use(libraryRoutes)
    .use(adminRoutes)
    .all("*", ({ set }: any) => { set.status = 404; return { error: "Not found" }; });
}
