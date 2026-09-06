// scripts/link-ashs-to-radarr.ts - Bridge ASHS /mnt/media/movie to Radarr /mnt/media/movies
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

  if (fs.existsSync(primary) && fs.statSync(primary).size > 1024 * 100) {
    return primary;
  }

  // Check candidate directory variants on the HDD (/mnt/media)
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
  Logger.info("[RadarrBridge] =====================================================");
  Logger.info("[RadarrBridge] Starting ASHS to Radarr HDD Bridge & Library Sync");
  Logger.info("[RadarrBridge] Target Root Folder: /mnt/media/movies (20TB HDD)");
  Logger.info("[RadarrBridge] =====================================================");

  // 1. Force target root folder on HDD
  const rootFolder = Config.RADARR_ROOT_FOLDER || "/mnt/media/movies";
  fs.mkdirSync(rootFolder, { recursive: true });

  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  // 2. Register /mnt/media/movies root folder in Radarr if missing
  if (Config.RADARR_ENABLED && Config.RADARR_API_KEY) {
    try {
      const rfRes = await fetch(`${radarrUrl}/api/v3/rootfolder`, { headers });
      if (rfRes.ok) {
        const rootFolders = await rfRes.json();
        const hasHddRoot = rootFolders.some((rf: any) => rf.path === rootFolder);
        if (!hasHddRoot) {
          const createRf = await fetch(`${radarrUrl}/api/v3/rootfolder`, {
            method: "POST",
            headers,
            body: JSON.stringify({ path: rootFolder }),
          });
          if (createRf.ok) {
            Logger.info(`[RadarrBridge] Registered "${rootFolder}" as root folder in Radarr`);
          }
        }

        // Delete old NVMe root folder (/media/Movies) if present
        for (const rf of rootFolders) {
          if (rf.path === "/media/Movies" || rf.path === "/opt/ashs/media/movies") {
            await fetch(`${radarrUrl}/api/v3/rootfolder/${rf.id}`, { method: "DELETE", headers }).catch(() => {});
            Logger.info(`[RadarrBridge] Removed old NVMe root folder: ${rf.path}`);
          }
        }
      }
    } catch (err: any) {
      Logger.warn(`[RadarrBridge] Root folder setup warning: ${err.message}`);
    }
  }

  // 3. Query all ready movies in ASHS DB
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

  // 4. Create symlinks on HDD from /mnt/media/movie/<tmdb_id>/... to /mnt/media/movies/<Title> (<Year>)/...
  let linked = 0;
  let alreadyLinked = 0;
  let missingSource = 0;

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

  Logger.info(`[RadarrBridge] Disk Symlinks: ${linked} newly linked, ${alreadyLinked} already linked, ${missingSource} missing source`);

  // 5. Register all ready movies into Radarr library so Radarr knows about them
  if (Config.RADARR_ENABLED && Config.RADARR_API_KEY) {
    try {
      const getMoviesRes = await fetch(`${radarrUrl}/api/v3/movie`, { headers });
      if (!getMoviesRes.ok) {
        throw new Error(`Failed to query Radarr movies (${getMoviesRes.status})`);
      }
      const existingMovies = await getMoviesRes.json();
      const existingTmdb = new Map<number, any>();
      for (const em of existingMovies) {
        if (em.tmdbId) existingTmdb.set(Number(em.tmdbId), em);
      }

      Logger.info(`[RadarrBridge] Currently ${existingMovies.length} movies in Radarr library`);

      // Bulk migrate any existing movies with wrong root folder
      const wrongPathMovies = existingMovies.filter((em: any) =>
        (em.rootFolderPath && em.rootFolderPath !== rootFolder) ||
        (em.path && !em.path.startsWith(rootFolder))
      );

      if (wrongPathMovies.length > 0) {
        Logger.info(`[RadarrBridge] Migrating ${wrongPathMovies.length} existing movies to ${rootFolder}...`);
        await fetch(`${radarrUrl}/api/v3/movie/editor`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            movieIds: wrongPathMovies.map((em: any) => em.id),
            rootFolderPath: rootFolder,
            moveFiles: false,
          }),
        }).catch(() => {});
      }

      // Add missing ASHS ready movies into Radarr
      const toAdd = readyMovies.filter((m: any) => !existingTmdb.has(Number(m.tmdb_id)));
      Logger.info(`[RadarrBridge] Adding ${toAdd.length} missing ASHS movies into Radarr...`);

      let addedCount = 0;
      for (let i = 0; i < toAdd.length; i++) {
        const m = toAdd[i];
        const tmdbId = parseInt(m.tmdb_id, 10);
        try {
          // Lookup rich metadata from Radarr TMDB integration
          let movieData: any = null;
          try {
            const lookupRes = await fetch(`${radarrUrl}/api/v3/movie/lookup?term=tmdb:${tmdbId}`, { headers });
            if (lookupRes.ok) {
              const lookupArr = await lookupRes.json();
              if (lookupArr && lookupArr.length > 0) {
                movieData = lookupArr[0];
              }
            }
          } catch {}

          const payload = {
            ...(movieData || {}),
            title: movieData?.title || m.title,
            year: movieData?.year || m.year,
            tmdbId,
            qualityProfileId: 1,
            rootFolderPath: rootFolder,
            monitored: true,
            addOptions: {
              searchForMovie: false, // File is already on disk, do not trigger torrent search
            },
          };

          const addRes = await fetch(`${radarrUrl}/api/v3/movie`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });

          if (addRes.ok) {
            addedCount++;
            if (addedCount % 10 === 0 || addedCount === toAdd.length) {
              Logger.info(`[RadarrBridge] Added to Radarr: [${addedCount}/${toAdd.length}] - Latest: "${m.title}"`);
            }
          } else {
            const errTxt = await addRes.text();
            Logger.warn(`[RadarrBridge] Could not add "${m.title}" (${tmdbId}): ${errTxt}`);
          }

          // Gentle pacing to avoid overloading Radarr
          await sleep(100);
        } catch (err: any) {
          Logger.warn(`[RadarrBridge] Failed to register "${m.title}": ${err.message}`);
        }
      }

      Logger.info(`[RadarrBridge] Successfully added ${addedCount} new movies to Radarr library!`);

      // 6. Trigger Radarr Rescan so all matched files turn green
      Logger.info("[RadarrBridge] Triggering Radarr RescanFolders & DownloadedMoviesScan...");
      await fetch(`${radarrUrl}/api/v3/command`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "RescanFolders" }),
      });

      await fetch(`${radarrUrl}/api/v3/command`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "DownloadedMoviesScan", path: rootFolder }),
      });

      Logger.info("[RadarrBridge] Scan triggered! Radarr will now link all movies on /mnt/media/movies.");
    } catch (e: any) {
      Logger.error(`[RadarrBridge] Radarr API sync error: ${e.message}`);
    }
  }

  Logger.info("[RadarrBridge] Sync completed successfully!");
}

main().catch((err) => {
  Logger.error(`[RadarrBridge] Fatal: ${err.message}`);
  process.exit(1);
});
