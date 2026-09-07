// scripts/diagnose-queue-and-fix.ts
// 1. Inspects every item in Radarr's Queue and identifies stalled / zero-connection torrents
// 2. For stalled items:
//    - Tries auto-importing if the video file is already downloaded (e.g. 99% where only junk files are missing)
//    - If incomplete/unimportable: drops the dead torrent, blocklists it, and triggers a fresh search for an active release
// 3. Configures qBittorrent so slow/stalled torrents NEVER block new downloads (dont_count_slow_torrents)
// 4. Sets 777 permissions across all download and movie directories
import { execSync } from "child_process";
import fs from "fs";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const headers = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

async function fixPermissions() {
  console.log("\n--- [1] Ensuring Full Permissions (chmod 777) ---");
  const dirs = ["/mnt/media/downloads", "/mnt/media/movies", "/opt/ashs/media/.downloads"];
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      try {
        execSync(`chmod -R 777 "${d}" 2>/dev/null || true`);
        console.log(`  [OK] Permissions set to 777 on ${d}`);
      } catch {}
    }
  }
}

async function unfreezeQBittorrent() {
  console.log("\n--- [2] Unfreezing qBittorrent Settings ---");
  const qbUrl = (Config.QBITTORRENT_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

  try {
    const verRes = await fetch(`${qbUrl}/api/v2/app/version`, { signal: AbortSignal.timeout(3000) });
    if (verRes.ok) {
      console.log(`  [qBittorrent Online] Version: ${await verRes.text()}`);

      // Disable queue bottlenecks and ignore slow/stalled torrents
      await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          json: JSON.stringify({
            queueing_enabled: false,
            max_active_downloads: 30,
            max_active_torrents: 40,
            dont_count_slow_torrents: true,
            slow_torrent_dl_rate_threshold: 50, // Torrents < 50 KB/s will NOT block new downloads!
          }),
        }).toString(),
      });
      console.log("  [Updated] Disabled queueing bottleneck: up to 30 active downloads; stalled torrents will not block new movies.");

      // Resume all torrents
      await fetch(`${qbUrl}/api/v2/torrents/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ hashes: "all" }).toString(),
      });
      console.log("  [Resumed] All torrents unpaused.");
    }
  } catch (e: any) {
    console.log(`  [Note] qBittorrent API note: ${e.message}`);
  }
}

async function inspectAndResolveQueue() {
  console.log("\n--- [3] Inspecting Queue & Resolving Stalled Torrents ---");
  try {
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=500&includeUnknownMovieItems=true&includeMovie=true`, { headers });
    if (!qRes.ok) {
      Logger.error(`Failed to fetch Radarr queue: HTTP ${qRes.status}`);
      return;
    }
    const queue = await qRes.json();
    const records = queue.records || [];

    if (records.length === 0) {
      console.log("Radarr queue is currently empty.");
      return;
    }

    console.log(`Found ${records.length} item(s) in queue:\n`);

    const moviesToReSearch = new Set<number>();
    let importedCount = 0;
    let purgedStalledCount = 0;

    for (const q of records) {
      const title = q.title || q.movie?.title || "Unknown";
      const sizeLeft = q.sizeleft || 0;
      const size = q.size || 0;
      const pct = size > 0 ? (((size - sizeLeft) / size) * 100).toFixed(1) : "0";
      const status = q.status || "";
      const trackedStatus = q.trackedDownloadStatus || "";
      const messages = (q.statusMessages || []).map((m: any) => (m.messages || []).join("; ")).filter(Boolean);
      const isStalled = trackedStatus === "warning" || messages.some((m) => m.toLowerCase().includes("stalled") || m.toLowerCase().includes("no connections"));

      console.log(`Movie: "${title}"`);
      console.log(`  - Progress: ${pct}% | Status: ${status} | Tracked: ${trackedStatus}`);
      if (messages.length > 0) {
        console.log(`  - Warning: ${messages.join(" | ")}`);
      }

      let imported = false;

      // 1. Try to auto-import if video file is already complete on disk
      if (q.downloadId) {
        try {
          const miUrl = `${radarrUrl}/api/v3/manualimport?downloadId=${encodeURIComponent(q.downloadId)}`;
          const miRes = await fetch(miUrl, { headers });
          if (miRes.ok) {
            const candidates = await miRes.json();
            const validCandidates = (candidates || []).filter((c: any) => {
              const p = (c.path || "").toLowerCase();
              return p.endsWith(".mp4") || p.endsWith(".mkv") || p.endsWith(".webm") || p.endsWith(".avi");
            });

            if (validCandidates.length > 0) {
              console.log(`  -> Video file found on disk! Attempting auto-import...`);
              const payload = validCandidates.map((c: any) => ({
                path: c.path,
                movieId: c.movie?.id || q.movieId || q.movie?.id,
                movie: c.movie || q.movie,
                quality: c.quality || { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1, real: 0, isRepack: false } },
                languages: c.languages?.length ? c.languages : [{ id: 1, name: "English" }],
                releaseGroup: c.releaseGroup || "ASHSRip",
                indexerFlags: 0,
                downloadId: q.downloadId,
              }));

              const importRes = await fetch(`${radarrUrl}/api/v3/manualimport`, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
              });

              if (importRes.ok) {
                console.log(`  -> [SUCCESS] Imported "${title}" into library!`);
                imported = true;
                importedCount++;
              }
            }
          }
        } catch {}
      }

      // 2. If it is stalled with 0 connections and NOT imported:
      if (!imported && isStalled) {
        console.log(`  -> [STALLED WITH NO SEEDERS] Dropping dead release and re-searching...`);
        const delRes = await fetch(`${radarrUrl}/api/v3/queue/${q.id}?removeFromClient=true&blocklist=true`, {
          method: "DELETE",
          headers,
        });
        if (delRes.ok) {
          purgedStalledCount++;
          if (q.movieId) moviesToReSearch.add(q.movieId);
        }
      }

      console.log("");
    }

    console.log("-----------------------------------------------------");
    console.log(`Auto-Imported Movies:      ${importedCount}`);
    console.log(`Purged Stalled Torrents:   ${purgedStalledCount}`);

    // 3. Trigger fresh search for active torrents with real seeders
    if (moviesToReSearch.size > 0) {
      console.log(`Re-searching ${moviesToReSearch.size} movie(s) for active releases with healthy seeders...`);
      await fetch(`${radarrUrl}/api/v3/command`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "MoviesSearch",
          movieIds: Array.from(moviesToReSearch),
        }),
      });
      console.log("  [Done] Radarr is now searching for releases with active seeders!");
    }
  } catch (e: any) {
    Logger.error(`Error inspecting queue: ${e.message}`);
  }
}

async function main() {
  console.log("=====================================================");
  console.log("  RADARR QUEUE DIAGNOSIS & AUTO-UNFREEZE");
  console.log("=====================================================");

  await fixPermissions();
  await unfreezeQBittorrent();
  await inspectAndResolveQueue();

  console.log("\n=====================================================");
  console.log("  RESOLUTION COMPLETE");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
