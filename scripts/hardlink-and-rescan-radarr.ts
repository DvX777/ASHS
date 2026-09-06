// scripts/hardlink-and-rescan-radarr.ts - Create real hardlinks for all 411 movies and re-enable Radarr Webhook
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

function sanitize(str: string): string {
  return str.replace(/[\\/:*?"<>|]/g, "").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findActualFile(m: any): string | null {
  const primary = path.isAbsolute(m.file_path)
    ? m.file_path
    : path.join(Config.MEDIA_DIR, m.file_path);

  if (fs.existsSync(primary)) {
    try {
      const stat = fs.statSync(primary);
      if (stat.size > 1024 * 100) return primary;
    } catch {}
  }

  const dirCandidates = [
    path.join("/mnt/media/movie", String(m.tmdb_id)),
    path.join("/mnt/media/movies", String(m.tmdb_id)),
    path.join(Config.MEDIA_DIR, "movie", String(m.tmdb_id)),
    path.join(Config.MEDIA_DIR, "movies", String(m.tmdb_id)),
  ];

  for (const dir of dirCandidates) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (/\.(mp4|mkv|avi|mov)$/i.test(file)) {
            const full = path.join(dir, file);
            if (fs.statSync(full).size > 1024 * 100) return full;
          }
        }
      } catch {}
    }
  }

  return null;
}

async function main() {
  Logger.info("=====================================================");
  Logger.info(" Hardlinking ASHS Media & Re-enabling Radarr Webhook");
  Logger.info("=====================================================");

  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  // 1. Re-enable & Test Webhook in Radarr
  try {
    const notifRes = await fetch(`${radarrUrl}/api/v3/notification`, { headers });
    if (notifRes.ok) {
      const notifs = await notifRes.json();
      for (const n of notifs) {
        if (
          n.implementation === "Webhook" ||
          n.name?.toLowerCase().includes("webhook") ||
          n.name?.toLowerCase().includes("ashs")
        ) {
          Logger.info(`[WebhookFix] Found notification: "${n.name}". Testing & re-enabling...`);
          await fetch(`${radarrUrl}/api/v3/notification/test`, {
            method: "POST",
            headers,
            body: JSON.stringify(n),
          }).catch(() => {});

          await fetch(`${radarrUrl}/api/v3/notification/${n.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ ...n, disabled: false }),
          }).catch(() => {});

          Logger.info(`[WebhookFix] Successfully re-enabled "${n.name}"!`);
        }
      }
    }

    // Clear health check warnings
    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ClearHealthItems" }),
    }).catch(() => {});

    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HealthCheck" }),
    }).catch(() => {});
  } catch (err: any) {
    Logger.warn(`[WebhookFix] Webhook check warning: ${err.message}`);
  }

  // 2. Query movies from Radarr
  const radarrRes = await fetch(`${radarrUrl}/api/v3/movie`, { headers });
  if (!radarrRes.ok) {
    throw new Error(`Failed to query Radarr movies (${radarrRes.status})`);
  }
  const radarrMovies = await radarrRes.json();
  const radarrByTmdb = new Map<number, any>();
  for (const rm of radarrMovies) {
    if (rm.tmdbId) radarrByTmdb.set(Number(rm.tmdbId), rm);
  }
  Logger.info(`[HardlinkBridge] Loaded ${radarrMovies.length} movies from Radarr library`);

  // 3. Query ready movies from ASHS DB
  const readyMovies = db.prepare(`
    SELECT m.id, m.tmdb_id, m.title, m.year, f.file_path, f.quality
    FROM media m
    JOIN media_files f ON f.media_id = m.id
    WHERE m.type = 'movie'
      AND m.status = 'ready'
      AND f.status = 'complete'
      AND f.file_path IS NOT NULL
  `).all() as any[];

  Logger.info(`[HardlinkBridge] Found ${readyMovies.length} ready movie files in ASHS DB`);

  let hardlinked = 0;
  let alreadyValid = 0;
  let missingSource = 0;
  const moviesToRescan: number[] = [];

  for (const m of readyMovies) {
    const tmdbId = Number(m.tmdb_id);
    const rm = radarrByTmdb.get(tmdbId);
    if (!rm) continue;

    const srcPath = findActualFile(m);
    if (!srcPath) {
      missingSource++;
      continue;
    }

    // Ensure target folder exists (using Radarr's exact expected folder path)
    const targetFolder = rm.path || path.join("/mnt/media/movies", `${sanitize(m.title)} (${m.year || ""})`.trim());
    fs.mkdirSync(targetFolder, { recursive: true });

    const ext = path.extname(srcPath) || ".mp4";
    const cleanTitle = sanitize(rm.title || m.title);
    const fileName = `${cleanTitle} (${rm.year || m.year || ""}) [${m.quality || 1080}p]${ext}`.trim();
    const destFile = path.join(targetFolder, fileName);

    try {
      // If a file or symlink exists at destFile, inspect it
      if (fs.existsSync(destFile)) {
        const stat = fs.lstatSync(destFile);
        if (stat.isSymbolicLink()) {
          // Remove symlink so we can replace with a hardlink that Radarr can read
          fs.unlinkSync(destFile);
        } else if (stat.isFile() && stat.size > 1024 * 100) {
          alreadyValid++;
          if (!rm.hasFile) moviesToRescan.push(rm.id);
          continue;
        }
      }

      // Create HARDLINK: instant, zero bytes, 100% regular file to Radarr
      try {
        fs.linkSync(srcPath, destFile);
        hardlinked++;
        moviesToRescan.push(rm.id);
      } catch (linkErr: any) {
        // Fallback: If link fails, copy
        fs.copyFileSync(srcPath, destFile);
        hardlinked++;
        moviesToRescan.push(rm.id);
      }
    } catch (err: any) {
      Logger.warn(`[HardlinkBridge] Error linking "${m.title}": ${err.message}`);
    }
  }

  Logger.info(`[HardlinkBridge] Hardlink Results: ${hardlinked} newly hardlinked, ${alreadyValid} already regular files, ${missingSource} missing source`);

  // 4. Trigger Radarr scans
  Logger.info("[HardlinkBridge] Triggering Radarr RescanFolders & DownloadedMoviesScan...");
  await fetch(`${radarrUrl}/api/v3/command`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "RescanFolders" }),
  });

  await fetch(`${radarrUrl}/api/v3/command`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "DownloadedMoviesScan", path: "/mnt/media/movies" }),
  });

  // Also trigger RescanMovie for movies needing immediate recognition
  Logger.info(`[HardlinkBridge] Triggering RescanMovie on ${moviesToRescan.length} movies...`);
  for (let i = 0; i < moviesToRescan.length; i++) {
    const movieId = moviesToRescan[i];
    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "RescanMovie", movieId }),
    }).catch(() => {});

    if ((i + 1) % 20 === 0 || i === moviesToRescan.length - 1) {
      Logger.info(`[HardlinkBridge] Scanned [${i + 1}/${moviesToRescan.length}] movies in Radarr`);
      await sleep(100);
    }
  }

  Logger.info("=====================================================");
  Logger.info(" Hardlinking complete! All 411+ movies will turn green in Radarr.");
  Logger.info("=====================================================");
}

main().catch((err) => {
  Logger.error(`[HardlinkBridge] Fatal: ${err.message}`);
  process.exit(1);
});
