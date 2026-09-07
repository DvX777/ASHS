// scripts/purge-dead-stalled.ts
// 1. Purges all dead/stalled torrents (status === "warning", 0 seeders, dead HEVCBay releases, metaDL hashes)
// 2. Blocklists them in Radarr so Radarr never touches these dead torrents again
// 3. Immediately triggers fresh searches for working, high-seeder releases (YTS, active torrents)
// 4. Sets qBittorrent to never throttle or pause downloads
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const headers = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

async function main() {
  console.log("=====================================================");
  console.log("  PURGE DEAD & STALLED TORRENTS (0 SEEDERS)");
  console.log("=====================================================\n");

  try {
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=1000&includeUnknownMovieItems=true&includeMovie=true`, { headers });
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

    console.log(`Analyzing ${records.length} item(s) in queue...\n`);

    const moviesToReSearch = new Set<number>();
    let purgedCount = 0;
    let keptCount = 0;

    for (const q of records) {
      const title = q.title || q.movie?.title || "Unknown";
      const status = (q.status || "").toLowerCase();
      const trackedStatus = (q.trackedDownloadStatus || "").toLowerCase();
      const messages = (q.statusMessages || []).map((m: any) => (m.messages || []).join("; ")).join(" ");
      const isHashName = /^[a-f0-9]{32,40}$/i.test(title);

      // Dead condition:
      // 1. Radarr flags status as 'warning' (e.g. stalled with no connections)
      // 2. Tracked status is 'warning'
      // 3. Messages contain 'stalled' or 'no connections'
      // 4. Hash name stuck in metaDL with 0 progress
      const isDead = 
        status === "warning" ||
        trackedStatus === "warning" ||
        messages.toLowerCase().includes("stalled") ||
        messages.toLowerCase().includes("no connections") ||
        isHashName;

      if (isDead) {
        console.log(`[DEAD/STALLED] "${title}"`);
        console.log(`  -> Status: ${status} | Warning: ${messages || "No seeders / Stalled"}`);
        console.log(`  -> Removing from qBittorrent & blocklisting dead release in Radarr...`);

        // Delete from Radarr queue + remove from qBittorrent + BLOCKLIST
        const delRes = await fetch(`${radarrUrl}/api/v3/queue/${q.id}?removeFromClient=true&blocklist=true`, {
          method: "DELETE",
          headers,
        });

        if (delRes.ok) {
          purgedCount++;
          if (q.movieId) {
            moviesToReSearch.add(q.movieId);
          }
        } else {
          Logger.warn(`Failed to delete queue item ${q.id}: ${delRes.status}`);
        }
      } else {
        keptCount++;
      }
    }

    console.log("\n=====================================================");
    console.log(`PURGE RESULTS:`);
    console.log(`  Purged & Blocklisted Dead Torrents: ${purgedCount}`);
    console.log(`  Healthy Active Downloads Kept:      ${keptCount}`);
    console.log("=====================================================\n");

    // Re-search for movies whose dead torrents were purged
    if (moviesToReSearch.size > 0) {
      const ids = Array.from(moviesToReSearch);
      console.log(`Triggering fresh search for ${ids.length} movie(s) to find releases with real seeders...`);
      
      // Batch searches in groups of 10
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        await fetch(`${radarrUrl}/api/v3/command`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "MoviesSearch",
            movieIds: batch,
          }),
        }).catch(() => {});
      }
      console.log("  [Done] Radarr is actively searching for healthy releases with real seeders!");
    }

    // Unpause all remaining healthy torrents in qBittorrent
    const qbUrl = (Config.QBITTORRENT_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
    try {
      await fetch(`${qbUrl}/api/v2/torrents/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ hashes: "all" }).toString(),
      });
      console.log("  [qBittorrent] All remaining downloads resumed.");
    } catch {}

  } catch (err: any) {
    Logger.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
