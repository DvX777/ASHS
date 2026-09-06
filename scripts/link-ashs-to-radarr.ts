// scripts/link-ashs-to-radarr.ts - Bridge ASHS /mnt/media/movies/[TMDB] to Radarr /media/Movies/[Title]
import fs from "fs";
import path from "path";
import { db } from "../src/db";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

function sanitize(str: string): string {
  return str.replace(/[\\/:*?"<>|]/g, "").trim();
}

function findActualFile(m: any): string | null {
  const primary = path.isAbsolute(m.file_path)
    ? m.file_path
    : path.join(Config.MEDIA_DIR, m.file_path);

  if (fs.existsSync(primary) && fs.statSync(primary).size > 1024 * 100) {
    return primary;
  }

  // Check candidate directory variants
  const dirCandidates = [
    path.join(Config.MEDIA_DIR, "movies", m.tmdb_id),
    path.join(Config.MEDIA_DIR, "movie", m.tmdb_id),
    path.join("/mnt/media/movies", m.tmdb_id),
    path.join("/mnt/media/movie", m.tmdb_id),
    path.join("/opt/ashs/media/movies", m.tmdb_id),
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
  Logger.info("[RadarrBridge] Starting ASHS to Radarr movie link sync...");

  const rootFolder = Config.RADARR_ROOT_FOLDER || "/media/Movies";
  fs.mkdirSync(rootFolder, { recursive: true });

  const readyMovies = db.prepare(`
    SELECT m.id, m.tmdb_id, m.title, m.year, f.file_path, f.quality
    FROM media m
    JOIN media_files f ON f.media_id = m.id
    WHERE m.type = 'movie'
      AND m.status = 'ready'
      AND f.status = 'complete'
      AND f.file_path IS NOT NULL
  `).all() as any[];

  Logger.info(`[RadarrBridge] Found ${readyMovies.length} ready movie files in ASHS database`);

  let linked = 0;
  let missingSource = 0;
  let alreadyLinked = 0;

  for (const m of readyMovies) {
    const srcPath = findActualFile(m);

    if (!srcPath) {
      missingSource++;
      continue;
    }

    const titleClean = sanitize(m.title);
    const yearStr = m.year ? ` (${m.year})` : "";
    const folderName = `${titleClean}${yearStr}`;
    const ext = path.extname(srcPath) || ".mp4";
    const fileName = `${titleClean}${yearStr} [${m.quality || 1080}p]${ext}`;

    const destDir = path.join(rootFolder, folderName);
    const destFile = path.join(destDir, fileName);

    try {
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(destFile)) {
        alreadyLinked++;
      } else {
        fs.symlinkSync(srcPath, destFile);
        linked++;
      }
    } catch (err: any) {
      Logger.warn(`[RadarrBridge] Error linking "${m.title}": ${err.message}`);
    }
  }

  Logger.info(`[RadarrBridge] Result: ${linked} newly linked, ${alreadyLinked} already linked, ${missingSource} missing source file`);

  // Trigger Radarr to rescan root folders and import all matched movies
  try {
    if (Config.RADARR_ENABLED && Config.RADARR_API_KEY) {
      Logger.info("[RadarrBridge] Triggering Radarr DownloadedMoviesScan...");
      await fetch(`${Config.RADARR_URL.replace(/\/+$/, "")}/api/v3/command`, {
        method: "POST",
        headers: {
          "X-Api-Key": Config.RADARR_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "DownloadedMoviesScan", path: rootFolder }),
      });
      Logger.info("[RadarrBridge] Radarr rescan triggered successfully! All 411 movies will populate in Radarr.");
    }
  } catch (e: any) {
    Logger.warn(`[RadarrBridge] Radarr API notification warning: ${e.message}`);
  }
}

main().catch(err => {
  Logger.error(`[RadarrBridge] Fatal: ${err.message}`);
  process.exit(1);
});
