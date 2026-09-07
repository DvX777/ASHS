// scripts/clean-junk-and-discs.ts - Scan & purge .m2ts, BDMV, .iso, .exe, and unstreamable disc junk
// Also auto-enables all qualities in Radarr profiles and auto-approves paused valid videos (mp4/mkv)
import fs from "fs";
import path from "path";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

const JUNK_EXTENSIONS = new Set([
  ".m2ts",
  ".iso",
  ".exe",
  ".bat",
  ".cmd",
  ".scr",
  ".vbs",
  ".rar",
  ".r00",
  ".r01",
  ".zip",
  ".7z",
  ".nfo",
  ".url",
  ".lnk",
]);

const JUNK_DIR_NAMES = new Set([
  "bdmv",
  "certificate",
  "audio_ts",
  "video_ts",
]);

let totalFreedBytes = 0;
let purgedFileCount = 0;
let purgedDirCount = 0;

function getDirSize(dir: string): number {
  let size = 0;
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) size += getDirSize(p);
      else if (f.isFile()) {
        try {
          size += fs.statSync(p).size;
        } catch {}
      }
    }
  } catch {}
  return size;
}

function scanAndPurgeDir(dir: string): void {
  if (!fs.existsSync(dir)) return;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: any) {
    Logger.warn(`[Purge] Cannot read dir ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // 1. Check for Junk Directories (BDMV, CERTIFICATE, etc.)
    if (entry.isDirectory()) {
      if (JUNK_DIR_NAMES.has(entry.name.toLowerCase())) {
        try {
          const size = getDirSize(fullPath);
          fs.rmSync(fullPath, { recursive: true, force: true });
          totalFreedBytes += size;
          purgedDirCount++;
          Logger.info(`[DELETED BDMV DIR] ${fmtBytes(size).padStart(9)} -> ${fullPath}`);
        } catch (e: any) {
          Logger.warn(`[Purge] Failed to remove dir ${fullPath}: ${e.message}`);
        }
      } else {
        // Recurse into subdirectories
        scanAndPurgeDir(fullPath);
      }
      continue;
    }

    // 2. Check for Junk Files (.m2ts, .iso, .exe, .rar, etc.)
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      let isJunk = JUNK_EXTENSIONS.has(ext);

      // Check for sample files (< 80MB with 'sample' in name)
      if (!isJunk && /\bsample\b/i.test(entry.name)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 80 * 1024 * 1024) isJunk = true;
        } catch {}
      }

      if (isJunk) {
        try {
          const stat = fs.statSync(fullPath);
          const size = stat.size;
          fs.unlinkSync(fullPath);
          totalFreedBytes += size;
          purgedFileCount++;
          Logger.info(`[DELETED JUNK FILE] ${fmtBytes(size).padStart(9)} -> ${fullPath}`);
        } catch (e: any) {
          Logger.warn(`[Purge] Failed to delete ${fullPath}: ${e.message}`);
        }
      }
    }
  }

  // Check if directory is now empty (clean up empty parent folders left after deleting junk)
  try {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0 && dir !== "/mnt/media/movies" && dir !== "/mnt/media/downloads") {
      fs.rmdirSync(dir);
    }
  } catch {}
}

async function cleanRadarrDbM2ts(): Promise<void> {
  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  try {
    Logger.info("[Radarr] Checking Radarr library for any registered .m2ts / disc files...");
    const res = await fetch(`${radarrUrl}/api/v3/movie`, { headers });
    if (!res.ok) return;
    const movies = await res.json();

    let radarrPurged = 0;
    for (const m of movies) {
      if (m.movieFile) {
        const filePath = (m.movieFile.relativePath || m.movieFile.path || "").toLowerCase();
        if (filePath.endsWith(".m2ts") || filePath.endsWith(".iso") || filePath.includes("bdmv")) {
          Logger.warn(`[Radarr] Found movie registered with disc file: "${m.title}" (${filePath}, ID: ${m.movieFile.id})`);
          // Delete moviefile from Radarr so Radarr unlinks the bad disc dump and can search for a clean copy
          const delRes = await fetch(`${radarrUrl}/api/v3/moviefile/${m.movieFile.id}`, {
            method: "DELETE",
            headers,
          });
          if (delRes.ok) {
            radarrPurged++;
            Logger.info(`[Radarr] Unlinked bad disc file from "${m.title}". Triggering re-search for clean MKV/MP4...`);
            // Trigger automatic re-search for a streamable mkv/mp4 release
            await fetch(`${radarrUrl}/api/v3/command`, {
              method: "POST",
              headers,
              body: JSON.stringify({ name: "MoviesSearch", movieIds: [m.id] }),
            }).catch(() => {});
          }
        }
      }
    }
    if (radarrPurged > 0) {
      Logger.info(`[Radarr] Cleaned ${radarrPurged} invalid disc file records from Radarr.`);
    } else {
      Logger.info("[Radarr] No .m2ts / disc files currently registered in Radarr library.");
    }
  } catch (err: any) {
    Logger.warn(`[Radarr] Error checking Radarr files: ${err.message}`);
  }
}

function allowAllQualityItems(items: any[]): boolean {
  let changed = false;
  for (const item of items) {
    if (item.allowed === false) {
      item.allowed = true;
      changed = true;
    }
    if (Array.isArray(item.items)) {
      if (allowAllQualityItems(item.items)) changed = true;
    }
  }
  return changed;
}

async function enableAllQualitiesInProfiles(): Promise<void> {
  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  try {
    Logger.info("[Radarr] Checking Quality Profiles to enable all formats (DVD, SD, 720p, 1080p, 4K)...");
    const res = await fetch(`${radarrUrl}/api/v3/qualityprofile`, { headers });
    if (!res.ok) return;
    const profiles = await res.json();

    for (const p of profiles) {
      if (Array.isArray(p.items)) {
        const modified = allowAllQualityItems(p.items);
        if (modified) {
          const updateRes = await fetch(`${radarrUrl}/api/v3/qualityprofile/${p.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify(p),
          });
          if (updateRes.ok) {
            Logger.info(`[Radarr] Profile "${p.name}" updated: DVD, SD, 720p, 1080p now allowed.`);
          }
        }
      }
    }
  } catch (err: any) {
    Logger.warn(`[Radarr] Profile update warning: ${err.message}`);
  }
}

async function autoApproveValidQueue(): Promise<void> {
  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };

  try {
    Logger.info("[Radarr] Checking for valid video files paused in queue/manual import...");
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=500&includeUnknownMovieItems=true&includeMovie=true`, { headers });
    if (!qRes.ok) return;
    const queue = await qRes.json();
    const records = queue.records || [];

    for (const q of records) {
      // Check if item has manual import warnings or needs review
      if (q.status === "warning" || q.trackedDownloadStatus === "warning" || q.statusMessages?.length > 0) {
        const title = q.title || q.movie?.title || "";
        Logger.info(`[AutoApprove] Examining paused item in queue: "${title}" (ID: ${q.id})`);

        // Query manual import endpoints
        let items: any[] = [];
        if (q.downloadId) {
          const miRes = await fetch(`${radarrUrl}/api/v3/manualimport?downloadId=${encodeURIComponent(q.downloadId)}`, { headers });
          if (miRes.ok) items = await miRes.json();
        }

        if (items.length === 0 && q.outputPath) {
          const miRes = await fetch(`${radarrUrl}/api/v3/manualimport?folder=${encodeURIComponent(q.outputPath)}`, { headers });
          if (miRes.ok) items = await miRes.json();
        }

        if (Array.isArray(items) && items.length > 0) {
          const validItems = items.filter((item: any) => {
            const p = (item.path || "").toLowerCase();
            return p.endsWith(".mp4") || p.endsWith(".mkv") || p.endsWith(".webm") || p.endsWith(".avi");
          });

          if (validItems.length > 0) {
            Logger.info(`[AutoApprove] Found ${validItems.length} valid video file(s) for "${title}". Executing auto-import...`);
            const importPayload = validItems.map((item: any) => ({
              path: item.path,
              movieId: item.movie?.id || q.movieId || q.movie?.id,
              movie: item.movie || q.movie,
              quality: item.quality || { quality: { id: 2, name: "DVD" }, revision: { version: 1, real: 0, isRepack: false } },
              languages: item.languages?.length ? item.languages : [{ id: 1, name: "English" }],
              releaseGroup: item.releaseGroup || "ASHSRip",
              indexerFlags: 0,
              downloadId: q.downloadId,
            }));

            const execRes = await fetch(`${radarrUrl}/api/v3/manualimport`, {
              method: "POST",
              headers,
              body: JSON.stringify(importPayload),
            });

            if (execRes.ok) {
              Logger.info(`[AutoApprove] Successfully auto-imported: "${title}"!`);
            } else {
              const errBody = await execRes.text();
              Logger.warn(`[AutoApprove] Manual import returned: ${execRes.status} ${errBody.substring(0, 120)}`);
            }
          }
        }
      }
    }
  } catch (err: any) {
    Logger.warn(`[AutoApprove] Error auto-approving queue: ${err.message}`);
  }
}

async function main() {
  console.log("\n=====================================================");
  console.log("  ASHS STORAGE PURGE: .m2ts, BDMV & JUNK SCANNER");
  console.log("=====================================================\n");

  // 1. Enable all qualities in profiles so DVD/720p classic movies never pause
  await enableAllQualitiesInProfiles();

  // 2. Auto-approve any valid video files stuck in manual import
  await autoApproveValidQueue();

  // 3. Purge .m2ts from Radarr database
  await cleanRadarrDbM2ts();

  // 4. Scan disk directories for .m2ts, BDMV, .iso, .exe, etc.
  const rawTargetDirs = [
    "/mnt/media/downloads",
    "/mnt/media/Downloads",
    "/mnt/media/movies",
    "/mnt/media/Movies",
    "/mnt/media/tv",
    "/mnt/media/TV",
    "/var/lib/ashs/Downloads",
    "/opt/ashs/media/.downloads",
    "/media/movies",
    "/media/Movies",
  ];

  const scannedRealPaths = new Set<string>();

  for (const dir of rawTargetDirs) {
    if (fs.existsSync(dir)) {
      try {
        const real = fs.realpathSync(dir);
        if (scannedRealPaths.has(real)) {
          continue; // Prevent scanning same symlinked folder twice
        }
        scannedRealPaths.add(real);
        Logger.info(`Scanning: ${dir} (resolved: ${real})...`);
        scanAndPurgeDir(real);
      } catch {
        Logger.info(`Scanning: ${dir}...`);
        scanAndPurgeDir(dir);
      }
    }
  }

  // 5. Trigger Radarr Rescan Disk so Radarr refreshes its view of all movies
  try {
    const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers: {
        "X-Api-Key": Config.RADARR_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "RescanMovie" }),
    });
    Logger.info("[Radarr] Dispatched RescanMovie command to refresh library state.");
  } catch {}

  console.log("\n=====================================================");
  console.log(`PURGE SUMMARY:`);
  console.log(`  Purged Junk Files:       ${purgedFileCount}`);
  console.log(`  Purged BDMV Directories: ${purgedDirCount}`);
  console.log(`  Total Reclaimed Space:   ${fmtBytes(totalFreedBytes)}`);
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
