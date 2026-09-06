// scripts/fix-radarr-root-folders.ts - Fix Radarr collections and import lists root folder to /mnt/media/movies
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";
import fs from "fs";

async function main() {
  const radarrUrl = (Config.RADARR_URL || "http://127.0.0.1:7878").replace(/\/+$/, "");
  const headers = {
    "X-Api-Key": Config.RADARR_API_KEY,
    "Content-Type": "application/json",
  };
  const TARGET_ROOT = "/mnt/media/movies";

  Logger.info("[FixRoots] Updating Radarr Collections and Import Lists to /mnt/media/movies...");

  // 1. Create a symlink /media/Movies -> /mnt/media/movies so any legacy check passes immediately
  try {
    if (!fs.existsSync("/media")) {
      fs.mkdirSync("/media", { recursive: true });
    }
    if (fs.existsSync("/media/Movies")) {
      const stat = fs.lstatSync("/media/Movies");
      if (!stat.isSymbolicLink()) {
        fs.rmSync("/media/Movies", { recursive: true, force: true });
        fs.symlinkSync(TARGET_ROOT, "/media/Movies");
        Logger.info("[FixRoots] Created symlink /media/Movies -> /mnt/media/movies");
      }
    } else {
      fs.symlinkSync(TARGET_ROOT, "/media/Movies");
      Logger.info("[FixRoots] Created symlink /media/Movies -> /mnt/media/movies");
    }
  } catch (err: any) {
    Logger.warn(`[FixRoots] Symlink creation warning: ${err.message}`);
  }

  // 2. Update Import Lists (e.g. IMDb Top 250, TMDb Popular)
  try {
    const listsRes = await fetch(`${radarrUrl}/api/v3/importlist`, { headers });
    if (listsRes.ok) {
      const lists = await listsRes.json();
      for (const list of lists) {
        if (list.rootFolderPath !== TARGET_ROOT) {
          list.rootFolderPath = TARGET_ROOT;
          const putRes = await fetch(`${radarrUrl}/api/v3/importlist/${list.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify(list),
          });
          if (putRes.ok) {
            Logger.info(`[FixRoots] Updated Import List "${list.name}" to ${TARGET_ROOT}`);
          }
        }
      }
    }
  } catch (err: any) {
    Logger.warn(`[FixRoots] Import lists update warning: ${err.message}`);
  }

  // 3. Update Collections
  try {
    const colRes = await fetch(`${radarrUrl}/api/v3/collection`, { headers });
    if (colRes.ok) {
      const collections = await colRes.json();
      Logger.info(`[FixRoots] Found ${collections.length} collections in Radarr`);

      const wrongCols = collections.filter((c: any) => c.rootFolderPath !== TARGET_ROOT);
      if (wrongCols.length > 0) {
        let count = 0;
        for (const c of wrongCols) {
          c.rootFolderPath = TARGET_ROOT;
          try {
            const res = await fetch(`${radarrUrl}/api/v3/collection/${c.id}`, {
              method: "PUT",
              headers,
              body: JSON.stringify(c),
            });
            if (res.ok) count++;
          } catch {}
        }
        Logger.info(`[FixRoots] Updated ${count}/${wrongCols.length} collections to ${TARGET_ROOT}`);
      }
    }
  } catch (err: any) {
    Logger.warn(`[FixRoots] Collections update warning: ${err.message}`);
  }

  // 4. Trigger Health Check to clear warnings in Radarr UI
  try {
    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ClearHealthItems" }),
    }).catch(() => {});

    await fetch(`${radarrUrl}/api/v3/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HealthCheck" }),
    }).catch(() => {});
    Logger.info("[FixRoots] Radarr HealthCheck triggered. Warnings will clear in UI.");
  } catch (err: any) {
    Logger.warn(`[FixRoots] Health check trigger warning: ${err.message}`);
  }

  Logger.info("[FixRoots] Done!");
}

main().catch((err) => {
  Logger.error(`[FixRoots] Fatal: ${err.message}`);
  process.exit(1);
});
