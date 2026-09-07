// scripts/handle-avi-and-clean-qbittorrent.ts
// 1. Cleans dead [missingFiles] torrents from qBittorrent (files purged earlier)
// 2. Adds .avi to Radarr blacklist/restrictions so only modern streamable MKV/MP4 are downloaded
// 3. Offers auto-conversion of any existing .avi to .mp4 via ffmpeg, or re-searching 1080p MKV for La Haine
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";

const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
const radarrHeaders = {
  "X-Api-Key": Config.RADARR_API_KEY,
  "Content-Type": "application/json",
};

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

async function cleanDeadMissingFiles() {
  console.log("\n--- [1] Cleaning Dead [missingFiles] in qBittorrent ---");
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

  try {
    const infoRes = await fetch(`${qbUrl}/api/v2/torrents/info`, { headers: qbHeaders });
    if (infoRes.ok) {
      const torrents = await infoRes.json();
      const missingHashes: string[] = [];

      for (const t of torrents) {
        if (t.state === "missingFiles") {
          missingHashes.push(t.hash);
        }
      }

      if (missingHashes.length > 0) {
        console.log(`Found ${missingHashes.length} torrent(s) with missing files. Removing from client...`);
        await fetch(`${qbUrl}/api/v2/torrents/delete`, {
          method: "POST",
          headers: qbHeaders,
          body: new URLSearchParams({ hashes: missingHashes.join("|"), deleteFiles: "false" }).toString(),
        });
        console.log(`[Cleaned] Removed ${missingHashes.length} ghost torrents from qBittorrent.`);
      } else {
        console.log("No missingFiles torrents found.");
      }
    }
  } catch (e: any) {
    Logger.error(`qBittorrent cleanup error: ${e.message}`);
  }
}

async function banAviInRadarr() {
  console.log("\n--- [2] Configuring Radarr to Prefer MKV/MP4 & Reject .avi ---");
  try {
    // Check indexer restrictions / tags
    const res = await fetch(`${radarrUrl}/api/v3/restriction`, { headers: radarrHeaders });
    if (res.ok) {
      const restrictions = await res.json();
      const existing = restrictions.find((r: any) => (r.ignored || "").toLowerCase().includes("avi"));
      if (!existing) {
        const payload = {
          ignored: "avi, divx, xvid",
          required: "",
          tags: [],
        };
        const createRes = await fetch(`${radarrUrl}/api/v3/restriction`, {
          method: "POST",
          headers: radarrHeaders,
          body: JSON.stringify(payload),
        });
        if (createRes.ok) {
          console.log(`[Success] Added restriction to Radarr: Ignored releases with [.avi, divx, xvid].`);
        }
      } else {
        console.log(`[Radarr Restriction OK] Already ignoring avi/divx/xvid.`);
      }
    }
  } catch (e: any) {
    Logger.warn(`Restriction update note: ${e.message}`);
  }
}

async function handleLaHaineAvi() {
  console.log("\n--- [3] Checking for La Haine .avi ---");
  const downloadDirs = ["/mnt/media/downloads", "/opt/ashs/media/.downloads", "/var/lib/ashs/Downloads"];
  let aviFound = "";

  for (const dir of downloadDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (/la\.haine.*\.avi$/i.test(f) || (/la.*haine/i.test(f) && f.endsWith(".avi"))) {
            aviFound = path.join(dir, f);
            break;
          }
        }
      } catch {}
    }
    if (aviFound) break;
  }

  if (aviFound) {
    console.log(`Found AVI file: ${aviFound}`);
    const mp4Out = aviFound.replace(/\.avi$/i, ".mp4");
    console.log(`Converting to web-streamable MP4 using ffmpeg...`);
    try {
      execSync(`ffmpeg -y -i "${aviFound}" -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k -movflags +faststart "${mp4Out}"`, {
        stdio: "inherit",
      });
      console.log(`\n[SUCCESS] Successfully converted to web-streamable MP4: ${mp4Out}`);
      // Remove the old AVI
      fs.unlinkSync(aviFound);
      console.log(`[Removed] Deleted old unstreamable .avi file.`);
    } catch (e: any) {
      Logger.warn(`ffmpeg conversion note: ${e.message}`);
    }
  } else {
    console.log("No raw La Haine .avi found in download directories.");
  }
}

async function main() {
  console.log("=====================================================");
  console.log("  QBITTORRENT CLEANUP & AVI TO MP4 HANDLER");
  console.log("=====================================================");

  await cleanDeadMissingFiles();
  await banAviInRadarr();
  await handleLaHaineAvi();

  console.log("\n=====================================================");
  console.log("  COMPLETE");
  console.log("=====================================================\n");
}

main().catch((err) => {
  Logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
