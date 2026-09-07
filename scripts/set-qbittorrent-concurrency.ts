// scripts/set-qbittorrent-concurrency.ts
// Unlocks qBittorrent download concurrency to 30 active slots
// Uses proper CSRF headers (Referer, Origin, Cookie) and force-starts all queued torrents
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");

async function getQBCreds() {
  try {
    const res = await fetch(`${radarrUrl}/api/v3/downloadclient`, {
      headers: { "X-Api-Key": Config.RADARR_API_KEY },
    });
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
  console.log("  UNLOCK QBITTORRENT CONCURRENCY & REMOVE 5-SLOT LIMIT");
  console.log("=====================================================\n");

  const creds = await getQBCreds();
  const qbUrl = `http://${creds.host}:${creds.port}`;
  console.log(`Connecting to qBittorrent at ${qbUrl}...`);

  // 1. Login with proper Referer
  let cookie = "";
  try {
    const loginRes = await fetch(`${qbUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: qbUrl,
        Origin: qbUrl,
      },
      body: new URLSearchParams({ username: creds.user, password: creds.pass }).toString(),
    });

    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
      console.log(`[Auth] Logged in to qBittorrent successfully!`);
    } else {
      console.log(`[Auth] No auth cookie returned (authentication may be disabled on localhost).`);
    }
  } catch (e: any) {
    Logger.error(`Login failed: ${e.message}`);
    return;
  }

  const qbHeaders: Record<string, string> = {
    Referer: qbUrl,
    Origin: qbUrl,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cookie) {
    qbHeaders["Cookie"] = cookie;
  }

  // 2. Check current preferences
  try {
    const prefRes = await fetch(`${qbUrl}/api/v2/app/preferences`, { headers: qbHeaders });
    if (prefRes.ok) {
      const prefs = await prefRes.json();
      console.log(`Current Settings before update:`);
      console.log(`  - queueing_enabled:       ${prefs.queueing_enabled}`);
      console.log(`  - max_active_downloads:   ${prefs.max_active_downloads}`);
      console.log(`  - max_active_torrents:    ${prefs.max_active_torrents}`);
    }

    // 3. Set preferences: DISABLE queueing, allow 30 active downloads
    console.log(`\nApplying new settings (max_active_downloads: 30, queueing_enabled: false)...`);
    const setRes = await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({
        json: JSON.stringify({
          queueing_enabled: false,
          max_active_downloads: 30,
          max_active_torrents: 40,
          dont_count_slow_torrents: true,
          slow_torrent_dl_rate_threshold: 50,
        }),
      }).toString(),
    });

    if (setRes.ok) {
      console.log(`[Success] Preferences updated!`);
    } else {
      console.log(`[Warning] setPreferences returned HTTP ${setRes.status}`);
    }

    // 4. Force-Start ALL torrents (bypasses any queue status)
    console.log(`\nForce-starting all torrents...`);
    await fetch(`${qbUrl}/api/v2/torrents/setForceStart`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({ hashes: "all", value: "true" }).toString(),
    });

    // 5. Resume ALL torrents
    await fetch(`${qbUrl}/api/v2/torrents/resume`, {
      method: "POST",
      headers: qbHeaders,
      body: new URLSearchParams({ hashes: "all" }).toString(),
    });

    // 6. Verify and show active torrent list
    const infoRes = await fetch(`${qbUrl}/api/v2/torrents/info`, { headers: qbHeaders });
    if (infoRes.ok) {
      const torrents = await infoRes.json();
      console.log(`\nActive Torrents in qBittorrent (${torrents.length} total):`);
      for (const t of torrents) {
        const speedMB = (t.dlspeed / 1024 / 1024).toFixed(2);
        const progressPct = (t.progress * 100).toFixed(1);
        console.log(`  - [${t.state}] ${progressPct}% (${speedMB} MB/s) | ${t.name.substring(0, 60)}`);
      }
    }

    console.log("\n=====================================================");
    console.log("  ALL DOWNLOAD SLOTS UNLOCKED!");
    console.log("=====================================================\n");

  } catch (err: any) {
    Logger.error(`Error: ${err.message}`);
  }
}

main();
