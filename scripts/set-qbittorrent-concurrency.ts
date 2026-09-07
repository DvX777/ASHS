// scripts/set-qbittorrent-concurrency.ts
// Unlocks qBittorrent download concurrency to 50 active slots
// Gathers actual torrent hashes and calls setForceStart on EVERY torrent
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
  console.log("  FORCE-UNLOCK ALL QBITTORRENT DOWNLOAD SLOTS");
  console.log("=====================================================\n");

  const creds = await getQBCreds();
  const qbUrl = `http://${creds.host}:${creds.port}`;

  // 1. Authenticate
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
      console.log(`[Auth] No auth required on localhost.`);
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

  // 2. Set Preferences to DISABLE Queueing and allow 50 downloads
  try {
    console.log(`Applying queueing_enabled=false, max_active_downloads=50...`);
    const setRes = await fetch(`${qbUrl}/api/v2/app/setPreferences`, {
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
    console.log(`[Preferences Update Status] HTTP ${setRes.status}`);

    // Verify preferences
    const prefRes = await fetch(`${qbUrl}/api/v2/app/preferences`, { headers: qbHeaders });
    if (prefRes.ok) {
      const prefs = await prefRes.json();
      console.log(`[Verified Preferences]`);
      console.log(`  - queueing_enabled:     ${prefs.queueing_enabled}`);
      console.log(`  - max_active_downloads: ${prefs.max_active_downloads}`);
      console.log(`  - max_active_torrents:  ${prefs.max_active_torrents}`);
    }

    // 3. Fetch ALL torrents and force-start each one by specific hash
    const infoRes = await fetch(`${qbUrl}/api/v2/torrents/info`, { headers: qbHeaders });
    if (infoRes.ok) {
      const torrents = await infoRes.json();
      console.log(`\nFound ${torrents.length} total torrents in qBittorrent.`);

      const hashes = torrents.map((t: any) => t.hash).join("|");
      if (hashes) {
        // FORCE START all torrents (bypasses queue limit completely)
        const fsRes = await fetch(`${qbUrl}/api/v2/torrents/setForceStart`, {
          method: "POST",
          headers: qbHeaders,
          body: new URLSearchParams({ hashes, value: "true" }).toString(),
        });
        console.log(`[ForceStart] Applied to all ${torrents.length} torrents (HTTP ${fsRes.status})`);

        // RESUME all torrents
        const resRes = await fetch(`${qbUrl}/api/v2/torrents/resume`, {
          method: "POST",
          headers: qbHeaders,
          body: new URLSearchParams({ hashes }).toString(),
        });
        console.log(`[Resume] Applied to all ${torrents.length} torrents (HTTP ${resRes.status})`);
      }

      // Re-fetch to display updated states
      await new Promise((r) => setTimeout(r, 1000));
      const updatedInfo = await (await fetch(`${qbUrl}/api/v2/torrents/info`, { headers: qbHeaders })).json();

      let activeDownloading = 0;
      console.log("\n--- Active Torrent States ---");
      for (const t of updatedInfo) {
        const speedMB = (t.dlspeed / 1024 / 1024).toFixed(2);
        const progressPct = (t.progress * 100).toFixed(1);
        const isDl = t.state.toLowerCase().includes("dl") && !t.state.toLowerCase().includes("pause");
        if (isDl) activeDownloading++;
        console.log(`  - [${t.state.padEnd(12)}] ${progressPct.padStart(5)}% (${speedMB.padStart(5)} MB/s) | ${t.name.substring(0, 50)}`);
      }
      console.log(`\nActive downloading torrents: ${activeDownloading} / ${updatedInfo.length}`);
    }

    console.log("\n=====================================================");
    console.log("  CONCURRENCY UNLOCKED SUCCESSFULLY");
    console.log("=====================================================\n");

  } catch (err: any) {
    Logger.error(`Error unlocking qBittorrent: ${err.message}`);
  }
}

main();
