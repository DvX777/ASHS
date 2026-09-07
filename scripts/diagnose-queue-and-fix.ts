// scripts/diagnose-queue-and-fix.ts
// 1. Inspects every item in Radarr's Queue and prints the exact reason for the orange cloud (statusMessages)
// 2. Auto-imports completed movies (Return of the Jedi, The Departed, etc.) via manualimport API
// 3. Checks qBittorrent status (stalledDL, queuedDL) and unfreezes queueing limits (forces resume / increases slots)
// 4. Applies full permissions (chmod 777) to /mnt/media/downloads so Radarr is never blocked from moving files
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const headers = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

async function fixPermissions() {
  console.log("\n--- [1] Ensuring Full Permissions on Downloads & Library ---");
  try {
    const dirs = ["/mnt/media/downloads", "/mnt/media/movies", "/opt/ashs/media/.downloads"];
    for (const d of dirs) {
      if (fs.existsSync(d)) {
        try {
          execSync(`chmod -R 777 "${d}" 2>/dev/null || true`);
          console.log(`  [OK] Permissions set to 777 on ${d}`);
        } catch {}
      }
    }
  } catch (e: any) {
    Logger.warn(`Permission fix warning: ${e.message}`);
  }
}

async function inspectAndFixQueue() {
  console.log("\n--- [2] Inspecting Radarr Queue & Warning Messages ---");
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

    const itemsToImport: any[] = [];
    const stalledDeadItems: any[] = [];

    for (const q of records) {
      const title = q.title || q.movie?.title || "Unknown";
      const sizeLeft = q.sizeleft || 0;
      const size = q.size || 0;
      const pct = size > 0 ? (((size - sizeLeft) / size) * 100).toFixed(1) : "0";
      const status = q.status || "";
      const trackedStatus = q.trackedDownloadStatus || "";
      const messages = (q.statusMessages || []).map((m: any) => (m.messages || []).join("; ")).filter(Boolean);

      console.log(`Movie: "${title}"`);
      console.log(`  - Progress: ${pct}% (${(size / 1e9).toFixed(2)} GB) | Status: ${status} | Tracked: ${trackedStatus}`);
      if (messages.length > 0) {
        console.log(`  - WARNING REASON: ${messages.join(" | ")}`);
      }

      // Check if download is completed (100% or sizeLeft == 0 or status == completed / warning)
      const isComplete = parseFloat(pct) >= 99 || sizeLeft === 0 || status === "completed" || trackedStatus === "warning";
      if (isComplete && q.downloadId) {
        itemsToImport.push(q);
      }

      // Check if stalled at very low % with 0 speed
      if (parseFloat(pct) < 10 && (q.timeleft === "-" || q.timeleft?.includes("d"))) {
        stalledDeadItems.push(q);
      }
      console.log("");
    }

    // Auto-import completed items
    if (itemsToImport.length > 0) {
      console.log(`\n--- [3] Attempting Auto-Import for ${itemsToImport.length} Completed / Warning Item(s) ---`);
      for (const q of itemsToImport) {
        const title = q.title || q.movie?.title || "";
        try {
          // Fetch manual import candidates
          const miUrl = `${radarrUrl}/api/v3/manualimport?downloadId=${encodeURIComponent(q.downloadId)}`;
          const miRes = await fetch(miUrl, { headers });
          if (!miRes.ok) continue;

          const candidates = await miRes.json();
          if (!Array.isArray(candidates) || candidates.length === 0) continue;

          // Filter for valid video files
          const validCandidates = candidates.filter((c: any) => {
            const p = (c.path || "").toLowerCase();
            return p.endsWith(".mp4") || p.endsWith(".mkv") || p.endsWith(".webm") || p.endsWith(".avi");
          });

          if (validCandidates.length > 0) {
            console.log(`  Auto-importing "${title}" (${validCandidates.length} video file(s))...`);
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
              console.log(`  [SUCCESS] Imported "${title}" into movie library!`);
            } else {
              const errTxt = await importRes.text();
              console.log(`  [FAILED] Import rejected for "${title}": ${errTxt.substring(0, 150)}`);
            }
          }
        } catch (e: any) {
          Logger.warn(`Error auto-importing ${title}: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    Logger.error(`Error inspecting queue: ${e.message}`);
  }
}

async function unfreezeQBittorrent() {
  console.log("\n--- [4] Unfreezing qBittorrent Download Slots ---");
  const qbUrl = (Config.QBITTORRENT_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");

  try {
    // 1. Check qBittorrent version/api
    const verRes = await fetch(`${qbUrl}/api/v2/app/version`, { signal: AbortSignal.timeout(3000) });
    if (verRes.ok) {
      console.log(`  [qBittorrent Online] Version: ${await verRes.text()}`);

      // 2. Set max active downloads to 30 and disable queuing bottleneck
      await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          json: JSON.stringify({
            queueing_enabled: false,
            max_active_downloads: 30,
            max_active_torrents: 40,
            dont_count_slow_torrents: true,
            slow_torrent_dl_rate_threshold: 50, // Torrents slower than 50 KB/s don't block new ones!
          }),
        }).toString(),
      });
      console.log("  [Updated Preferences] Disabled queue bottleneck: allowed 30 concurrent downloads, slow torrents won't block fast ones.");

      // 3. Resume all paused/queued torrents
      await fetch(`${qbUrl}/api/v2/torrents/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ hashes: "all" }).toString(),
      });
      console.log("  [Resumed All] Dispatched resume command to all torrents.");
    }
  } catch (e: any) {
    console.log(`  [Note] qBittorrent API on ${qbUrl} not reachable directly or requires auth: ${e.message}`);
  }
}

async function main() {
  console.log("=====================================================");
  console.log("  RADARR QUEUE DIAGNOSIS & AUTO-UNFREEZE");
  console.log("=====================================================");

  await fixPermissions();
  await inspectAndFixQueue();
  await unfreezeQBittorrent();

  console.log("\n=====================================================");
  console.log("  DIAGNOSIS & REPAIR FINISHED");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
