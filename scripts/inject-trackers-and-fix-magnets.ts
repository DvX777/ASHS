// scripts/inject-trackers-and-fix-magnets.ts
// 1. Injects the top worldwide trackers into qBittorrent so magnet links (metaDL) find seeders instantly
// 2. Calls addTrackers + reannounce on all stuck metaDL torrents (grey cloud movies)
// 3. Enables DHT, PeX, and auto-trackers in qBittorrent preferences
// 4. Deduplicates the queue (removes duplicate CAM/DVD-R grabs when a better release is already downloading)
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const radarrHeaders = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

const TOP_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://tracker.dler.org:6969/announce",
  "http://tracker.openbittorrent.com:80/announce",
  "udp://movies.zsw.ca:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.theoks.net:6969/announce",
  "udp://retracker.lanta-net.ru:2710/announce",
];

async function getQBCreds() {
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

async function main() {
  console.log("=====================================================");
  console.log("  INJECT TIER-1 TRACKERS & UNFREEZE MAGNET (metaDL)");
  console.log("=====================================================\n");

  const creds = await getQBCreds();
  const qbUrl = `http://${creds.host}:${creds.port}`;

  let cookie = "";
  try {
    const loginRes = await fetch(`${qbUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: qbUrl, Origin: qbUrl },
      body: new URLSearchParams({ username: creds.user, password: creds.pass }).toString(),
    });
    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
  } catch {}

  const qbHeaders: Record<string, string> = {
    Referer: qbUrl,
    Origin: qbUrl,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) qbHeaders["Cookie"] = cookie;

  // 1. Enable DHT, PeX, and Auto-Trackers in qBittorrent Preferences
  console.log("--- [1] Updating qBittorrent Network & Tracker Preferences ---");
  try {
    await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({
        json: JSON.stringify({
          dht: true,
          pex: true,
          lsd: true,
          add_trackers_enabled: true,
          add_trackers: TOP_TRACKERS.join("\n"),
          enable_utp: true,
        }),
      }).toString(),
    });
    console.log(`[Success] Configured auto-tracker injection with ${TOP_TRACKERS.length} tier-1 trackers.`);
  } catch (e: any) {
    Logger.warn(`Preferences update note: ${e.message}`);
  }

  // 2. Check DHT Node connectivity
  try {
    const serverStateRes = await fetch(`${qbUrl}/api/v2/transfer/info`, { headers: qbHeaders });
    if (serverStateRes.ok) {
      const state = await serverStateRes.json();
      console.log(`Connection state: DHT Nodes = ${state.dht_nodes || 0}, DL Speed = ${((state.dl_info_speed || 0) / 1024 / 1024).toFixed(2)} MB/s`);
    }
  } catch {}

  // 3. Inject trackers and re-announce for all metaDL / stalled torrents
  console.log("\n--- [2] Injecting Trackers Into metaDL Torrents ---");
  try {
    const infoRes = await fetch(`${qbUrl}/api/v2/torrents/info`, { headers: qbHeaders });
    if (infoRes.ok) {
      const torrents = await infoRes.json();
      let metaDlCount = 0;
      const trackerUrls = TOP_TRACKERS.join("\n");

      for (const t of torrents) {
        // If torrent is waiting for metadata or stalled at 0%
        if (t.state === "metaDL" || (t.progress === 0 && t.dlspeed === 0)) {
          metaDlCount++;
          // Add top trackers
          await fetch(`${qbUrl}/api/v2/torrents/addTrackers`, {
            method: "POST",
            headers: qbHeaders,
            body: new URLSearchParams({
              hash: t.hash,
              urls: trackerUrls,
            }).toString(),
          });
          // Force reannounce
          await fetch(`${qbUrl}/api/v2/torrents/reannounce`, {
            method: "POST",
            headers: qbHeaders,
            body: new URLSearchParams({ hashes: t.hash }).toString(),
          });
        }
      }
      console.log(`Injected tier-1 trackers into ${metaDlCount} magnet torrent(s).`);
    }
  } catch (e: any) {
    Logger.error(`Error injecting trackers: ${e.message}`);
  }

  // 4. Deduplicate Radarr Queue
  console.log("\n--- [3] Checking for Duplicate Movie Grabs in Queue ---");
  try {
    const qRes = await fetch(`${radarrUrl}/api/v3/queue?pageSize=500&includeUnknownMovieItems=true&includeMovie=true`, { headers: radarrHeaders });
    if (qRes.ok) {
      const queue = await qRes.json();
      const records = queue.records || [];
      const movieMap = new Map<number, any[]>();

      for (const r of records) {
        if (r.movieId) {
          if (!movieMap.has(r.movieId)) movieMap.set(r.movieId, []);
          movieMap.get(r.movieId)!.push(r);
        }
      }

      let removedDups = 0;
      for (const [movieId, items] of movieMap.entries()) {
        if (items.length > 1) {
          // Sort so the best/furthest along item is first
          items.sort((a, b) => {
            const pctA = a.size > 0 ? (a.size - (a.sizeleft || 0)) / a.size : 0;
            const pctB = b.size > 0 ? (b.size - (b.sizeleft || 0)) / b.size : 0;
            return pctB - pctA;
          });

          // Keep item 0, drop the rest (e.g. CAM or lower quality duplicates)
          const keep = items[0];
          for (let i = 1; i < items.length; i++) {
            const drop = items[i];
            const dropTitle = drop.title || drop.movie?.title || "";
            console.log(`  Dropping duplicate release: "${dropTitle}" (Keeping: "${keep.title || keep.movie?.title}")`);
            await fetch(`${radarrUrl}/api/v3/queue/${drop.id}?removeFromClient=true&blocklist=false`, {
              method: "DELETE",
              headers: radarrHeaders,
            });
            removedDups++;
          }
        }
      }
      console.log(`Cleaned ${removedDups} duplicate grab(s).`);
    }
  } catch (e: any) {
    Logger.warn(`Deduplication note: ${e.message}`);
  }

  console.log("\n=====================================================");
  console.log("  TRACKERS INJECTED & QUEUE DEDUPLICATED");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
