// scripts/optimize-radarr-and-queue.ts
// 1. Purges dead/stuck queue torrents (BR-DISK, 70GB Remuxes, unreleased 2026 fakes, 17-day stalls)
// 2. Disables BR-DISK and Remux in Quality Profiles (so Radarr only grabs fast 1.5-6GB 1080p/720p releases)
// 3. Inspects current Indexers and checks Prowlarr/Jackett status
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const headers = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

async function inspectIndexers() {
  console.log("\n--- [1] Checking Radarr Indexers ---");
  try {
    const res = await fetch(`${radarrUrl}/api/v3/indexer`, { headers });
    if (!res.ok) {
      Logger.warn(`Failed to fetch indexers: ${res.status}`);
      return;
    }
    const indexers = await res.json();
    if (indexers.length === 0) {
      Logger.warn("No indexers configured in Radarr! Radarr cannot search without indexers.");
    } else {
      console.log(`Found ${indexers.length} configured indexer(s):`);
      for (const idx of indexers) {
        console.log(`  - [${idx.protocol || "torrent"}] ${idx.name} (Enabled: ${idx.enableAutomaticSearch})`);
      }
    }
  } catch (e: any) {
    Logger.error(`Error fetching indexers: ${e.message}`);
  }

  // Check Prowlarr and Jackett ports
  console.log("\n--- Checking Indexer Managers (Prowlarr / Jackett) ---");
  for (const [name, port] of [["Prowlarr", 9696], ["Jackett", 9117]] as const) {
    try {
      const ping = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
      console.log(`  [OK] ${name} is RUNNING on port ${port} (HTTP ${ping.status})`);
    } catch {
      console.log(`  [--] ${name} is NOT detected on port ${port}`);
    }
  }
}

function disableDiscAndRemux(items: any[]): boolean {
  let changed = false;
  for (const item of items) {
    const name = (item.quality?.name || item.name || "").toLowerCase();
    // Disable raw discs and huge uncompressed remuxes
    if (
      name.includes("br-disk") ||
      name.includes("raw-hd") ||
      name.includes("remux")
    ) {
      if (item.allowed !== false) {
        item.allowed = false;
        changed = true;
      }
    } else {
      // Enable web-dl, webrip, bluray rip, hdtv, dvd
      if (item.allowed === false) {
        item.allowed = true;
        changed = true;
      }
    }
    if (Array.isArray(item.items)) {
      if (disableDiscAndRemux(item.items)) changed = true;
    }
  }
  return changed;
}

async function tuneQualityProfiles() {
  console.log("\n--- [2] Tuning Quality Profiles (Ban BR-DISK & 70GB Remuxes) ---");
  try {
    const res = await fetch(`${radarrUrl}/api/v3/qualityprofile`, { headers });
    if (!res.ok) return;
    const profiles = await res.json();

    for (const p of profiles) {
      if (Array.isArray(p.items)) {
        const modified = disableDiscAndRemux(p.items);
        if (modified) {
          const putRes = await fetch(`${radarrUrl}/api/v3/qualityprofile/${p.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify(p),
          });
          if (putRes.ok) {
            console.log(`  [Updated] Profile "${p.name}": Banned BR-DISK / Remux. Enabled 1080p/720p Web-DL & BluRay.`);
          }
        } else {
          console.log(`  [Profile OK] "${p.name}" already tuned.`);
        }
      }
    }
  } catch (e: any) {
    Logger.error(`Error tuning profiles: ${e.message}`);
  }
}

async function purgeStalledQueueAndReSearch() {
  console.log("\n--- [3] Cleaning Dead, Stalled & BR-DISK Queue Items ---");
  try {
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=500&includeUnknownMovieItems=true&includeMovie=true`, { headers });
    if (!qRes.ok) return;
    const queue = await qRes.json();
    const records = queue.records || [];

    const movieIdsToReSearch = new Set<number>();
    let purgedCount = 0;

    for (const q of records) {
      const title = q.title || q.movie?.title || "Unknown";
      const qName = (q.quality?.quality?.name || "").toLowerCase();
      const timeLeft = q.timeleft || "";
      const year = q.movie?.year || 0;

      let shouldPurge = false;
      let reason = "";

      // 1. Raw Blu-ray discs / Remuxes
      if (qName.includes("br-disk") || qName.includes("remux")) {
        shouldPurge = true;
        reason = `Huge unstreamable format (${q.quality?.quality?.name})`;
      }
      // 2. Unreleased movies in 2026 (fakes/cam rips with no seeders)
      else if (
        title.toLowerCase().includes("mario galaxy") ||
        title.toLowerCase().includes("project hail mary") ||
        title.toLowerCase().includes("brand new day")
      ) {
        shouldPurge = true;
        reason = "Unreleased movie / fake placeholder release";
      }
      // 3. Stalled downloads with ridiculous time remaining (> 3 days or 17 days)
      else if (timeLeft.includes("d") && (parseInt(timeLeft, 10) >= 3 || timeLeft.includes("17d"))) {
        shouldPurge = true;
        reason = `Dead torrent with stalled speed (${timeLeft} remaining)`;
      }

      if (shouldPurge) {
        console.log(`  [PURGING] "${title}" - Reason: ${reason} (ID: ${q.id})`);
        // Remove from client, blocklist the bad release so Radarr won't grab it again
        const delRes = await fetch(`${radarrUrl}/api/v3/queue/${q.id}?removeFromClient=true&blocklist=true`, {
          method: "DELETE",
          headers,
        });

        if (delRes.ok) {
          purgedCount++;
          if (q.movieId && year < 2026) {
            movieIdsToReSearch.add(q.movieId);
          }
        } else {
          Logger.warn(`  Failed to remove ${q.id}: ${delRes.status}`);
        }
      }
    }

    console.log(`\nPurged ${purgedCount} bad/dead download(s) from Queue & qBittorrent.`);

    // Trigger fresh searches for the valid released movies (so Radarr gets fast 1080p web releases)
    if (movieIdsToReSearch.size > 0) {
      console.log(`Triggering clean 1080p searches for ${movieIdsToReSearch.size} movie(s)...`);
      const searchRes = await fetch(`${radarrUrl}/api/v3/command`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "MoviesSearch",
          movieIds: Array.from(movieIdsToReSearch),
        }),
      });
      if (searchRes.ok) {
        console.log("  [Done] Radarr is now searching for fast, high-seed releases!");
      }
    }
  } catch (e: any) {
    Logger.error(`Error cleaning queue: ${e.message}`);
  }
}

async function main() {
  console.log("=====================================================");
  console.log("  ASHS RADARR OPTIMIZER & INDEXER INSPECTOR");
  console.log("=====================================================");

  await inspectIndexers();
  await tuneQualityProfiles();
  await purgeStalledQueueAndReSearch();

  console.log("\n=====================================================");
  console.log("  OPTIMIZATION COMPLETE");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
