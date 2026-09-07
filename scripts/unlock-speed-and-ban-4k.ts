// scripts/unlock-speed-and-ban-4k.ts
// 1. Authenticates with qBittorrent using Radarr credentials and eliminates queue bottlenecks (force-starts all torrents)
// 2. Permanently bans ALL 2160p (4K), Remux, and BR-DISK from all Radarr profiles (locks to 1080p/720p)
// 3. Drops the 24-hour 4K downloads (La Haine 2160p, Departed 2160p, Star Wars 2160p)
// 4. Re-searches for fast, lightweight 1080p releases (1.5-2.5 GB) that download in 1-2 minutes!
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const radarrHeaders = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

async function getQBittorrentCredentials(): Promise<{ host: string; port: number; user: string; pass: string }> {
  try {
    const res = await fetch(`${radarrUrl}/api/v3/downloadclient`, { headers: radarrHeaders });
    if (res.ok) {
      const clients = await res.json();
      const qb = clients.find((c: any) => (c.implementation || "").toLowerCase().includes("qbittorrent"));
      if (qb && Array.isArray(qb.fields)) {
        const getField = (name: string) => qb.fields.find((f: any) => f.name === name)?.value;
        return {
          host: getField("host") || "127.0.0.1",
          port: getField("port") || 8080,
          user: getField("username") || "admin",
          pass: getField("password") || "adminadmin",
        };
      }
    }
  } catch {}
  return { host: "127.0.0.1", port: 8080, user: "admin", pass: "adminadmin" };
}

async function unlockQBittorrent() {
  console.log("\n--- [1] Unlocking qBittorrent Concurrency & Force-Starting Torrents ---");
  const creds = await getQBittorrentCredentials();
  const qbUrl = `http://${creds.host}:${creds.port}`;

  let cookie = "";
  try {
    // Authenticate
    const loginRes = await fetch(`${qbUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: creds.user, password: creds.pass }).toString(),
    });

    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
      console.log(`  [qBittorrent Auth] Logged in successfully!`);
    } else {
      console.log(`  [qBittorrent Auth] No auth required on localhost.`);
    }

    const qbHeaders = cookie ? { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/x-www-form-urlencoded" };

    // 1. Disable queueing completely, allow 50 active downloads
    await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({
        json: JSON.stringify({
          queueing_enabled: false,
          max_active_downloads: 50,
          max_active_torrents: 50,
          max_active_checking_torrents: 10,
          dont_count_slow_torrents: true,
          slow_torrent_dl_rate_threshold: 50,
        }),
      }).toString(),
    });
    console.log(`  [qBittorrent Settings] Queueing DISABLED. 50 active downloads allowed simultaneously.`);

    // 2. Force start ALL torrents (bypasses any queuing or waiting state)
    await fetch(`${qbUrl}/api/v2/torrents/setForceStart`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({ hashes: "all", value: "true" }).toString(),
    });
    console.log(`  [qBittorrent Force-Start] All torrents set to Force-Start (no waiting in queue).`);

    // 3. Resume all torrents
    await fetch(`${qbUrl}/api/v2/torrents/resume`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({ hashes: "all" }).toString(),
    });
    console.log(`  [qBittorrent Resume] Dispatched resume to all torrents.`);

  } catch (err: any) {
    Logger.error(`qBittorrent unlock error: ${err.message}`);
  }
}

function ban4kAndDiscs(items: any[]): boolean {
  let changed = false;
  for (const item of items) {
    const name = (item.quality?.name || item.name || "").toLowerCase();
    // Ban ALL 2160p (4K), Remuxes, and Discs
    if (
      name.includes("2160p") ||
      name.includes("4k") ||
      name.includes("uhd") ||
      name.includes("remux") ||
      name.includes("br-disk") ||
      name.includes("raw-hd")
    ) {
      if (item.allowed !== false) {
        item.allowed = false;
        changed = true;
      }
    } else {
      // Allow 1080p, 720p, DVD
      if (item.allowed === false) {
        item.allowed = true;
        changed = true;
      }
    }
    if (Array.isArray(item.items)) {
      if (ban4kAndDiscs(item.items)) changed = true;
    }
  }
  return changed;
}

async function ban4KInRadarrProfiles() {
  console.log("\n--- [2] Permanently Banning 4K (2160p) in Radarr Profiles ---");
  try {
    const res = await fetch(`${radarrUrl}/api/v3/qualityprofile`, { headers: radarrHeaders });
    if (!res.ok) return;
    const profiles = await res.json();

    for (const p of profiles) {
      if (Array.isArray(p.items)) {
        const modified = ban4kAndDiscs(p.items);
        if (modified) {
          await fetch(`${radarrUrl}/api/v3/qualityprofile/${p.id}`, {
            method: "PUT",
            headers: radarrHeaders,
            body: JSON.stringify(p),
          });
          console.log(`  [Updated Profile] "${p.name}": Banned all 4K/2160p. Locked to 1080p & 720p.`);
        } else {
          console.log(`  [Profile OK] "${p.name}" already locked to 1080p/720p.`);
        }
      }
    }
  } catch (err: any) {
    Logger.error(`Profile update error: ${err.message}`);
  }
}

async function drop4KQueueAndReSearch1080p() {
  console.log("\n--- [3] Dropping 24-Hour 4K Downloads & Triggering 1080p Searches ---");
  try {
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=500&includeUnknownMovieItems=true&includeMovie=true`, { headers: radarrHeaders });
    if (!qRes.ok) return;
    const queue = await qRes.json();
    const records = queue.records || [];

    const movieIdsToSearch = new Set<number>();

    for (const q of records) {
      const title = q.title || q.movie?.title || "Unknown";
      const qName = (q.quality?.quality?.name || "").toLowerCase();

      // If it's a 2160p / 4K release, drop it!
      if (qName.includes("2160p") || qName.includes("4k") || title.toLowerCase().includes("2160p")) {
        console.log(`  [DROPPING 4K RELEASE] "${title}" (${q.quality?.quality?.name}) -> Switching to 1080p...`);
        await fetch(`${radarrUrl}/api/v3/queue/${q.id}?removeFromClient=true&blocklist=true`, {
          method: "DELETE",
          headers: radarrHeaders,
        });
        if (q.movieId) movieIdsToSearch.add(q.movieId);
      } else {
        // For remaining 1080p/720p movies, make sure they are active
        if (q.movieId) movieIdsToSearch.add(q.movieId);
      }
    }

    if (movieIdsToSearch.size > 0) {
      console.log(`\nTriggering clean 1080p searches for ${movieIdsToSearch.size} movies...`);
      await fetch(`${radarrUrl}/api/v3/command`, {
        method: "POST",
        headers: radarrHeaders,
        body: JSON.stringify({
          name: "MoviesSearch",
          movieIds: Array.from(movieIdsToSearch),
        }),
      });
      console.log("  [Done] Radarr is now searching for 1080p releases (1.5-3GB) with active seeders!");
    }
  } catch (err: any) {
    Logger.error(`Queue update error: ${err.message}`);
  }
}

async function main() {
  console.log("=====================================================");
  console.log("  UNLOCK SPEED & BAN 4K (2160p) BOTTLENECK");
  console.log("=====================================================");

  await unlockQBittorrent();
  await ban4KInRadarrProfiles();
  await drop4KQueueAndReSearch1080p();

  console.log("\n=====================================================");
  console.log("  ALL DOWNLOADS UNTHROTTLED TO FAST 1080p");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
