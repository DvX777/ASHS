// src/index.ts — ASHS entry point
// Starts: API server (:4000), File server (:4001), ingestion scheduler, download manager

import "./db"; // Initialize DB + run setup
import { Config } from "./config";
import { Logger } from "./utils/logger";
import { Discord } from "./utils/discord";
import { createApiApp } from "./api/app";
import { createFileApp } from "./fileserver/app";
import { startScheduler } from "./ingestion/scheduler";
import { startDownloadManager } from "./download/manager";
import fs from "fs";

// Ensure required directories exist
fs.mkdirSync(Config.TEMP_DIR,  { recursive: true });
fs.mkdirSync(Config.MEDIA_DIR, { recursive: true });

async function main() {
  Logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  Logger.info("  ASHS — Auto Self-Hosted System");
  Logger.info("  MoviesDB v1.0.0");
  Logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Start API server
  const apiApp = createApiApp();
  apiApp.listen(Config.API_PORT, () => {
    Logger.info(`[API] Listening on port ${Config.API_PORT}`);
  });

  // Start file server
  const fileApp = createFileApp();
  fileApp.listen(Config.FILE_PORT, () => {
    Logger.info(`[FileServer] Listening on port ${Config.FILE_PORT}`);
  });

  // Start background services
  startScheduler().catch(err => Logger.error(`[Scheduler] Fatal: ${err.message}`));
  startDownloadManager().catch(err => Logger.error(`[DownloadManager] Fatal: ${err.message}`));

  await Discord.success("ASHS Started", `API: :${Config.API_PORT} | Files: :${Config.FILE_PORT}`);
  Logger.info("[ASHS] All services started successfully");
}

main().catch(err => {
  Logger.error(`[ASHS] Fatal startup error: ${err.message}`);
  process.exit(1);
});
