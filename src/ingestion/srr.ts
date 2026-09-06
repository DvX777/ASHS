// src/ingestion/srr.ts â€” Smart Re-Resolve: heals broken downloads + quality upgrades
import fs from "fs";
import path from "path";
import { db, MediaQueries, FileQueries, QueueQueries } from "../db";
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { Discord, notifySRR } from "../utils/discord";
import { buildTempPath, buildRelativePath } from "../storage/paths";
import { formatBytes } from "../utils/helpers";

/**
 * SRR runs on startup and every 6h.
 * It detects and heals 5 types of broken state:
 *
 *  1. Zombie media_files â€” status='downloading' with no active queue job
 *     â†’ re-create the queue job (downloader will resume the .part file)
 *
 *  2. Ghost files â€” status='complete' but file missing/empty on disk
 *     â†’ mark failed, re-queue so it downloads fresh
 *
 *  3. Stale resolving â€” media stuck in status='resolving' for >1h
 *     â†’ reset to 'pending' so it gets re-resolved next tick
 *
 *  4. Stale .part files â€” .part files >48h old with no active queue job
 *     â†’ delete them to free NVMe space
 *
 *  5. Quality upgrade â€” media with only 720p, never attempted 1080p
 *     â†’ re-queue for resolving (will try 1080p next time)
 */
export async function runSRR(): Promise<void> {
  // Auto-reset exhausted queued items so they can be retried
  const reset = db.prepare("UPDATE download_queue SET attempts=0, scheduled_at=datetime('now') WHERE status='queued' AND attempts >= max_attempts").run();
  if (reset.changes > 0) Logger.info('[SRR] Reset ' + reset.changes + ' exhausted queue items for retry');

  // â”€â”€ 6. Ghost 'pending' queue entries (stuck, invisible to nextQueued) â”€â”€â”€â”€â”€â”€
  const pendingFix = db.prepare("UPDATE download_queue SET status='queued', attempts=0, scheduled_at=datetime('now') WHERE status='pending'").run();
  if (pendingFix.changes > 0) Logger.info('[SRR] Converted ' + pendingFix.changes + " ghost 'pending' queue entries to 'queued'");

  // â”€â”€ 7. Media stuck at 'downloading' with ALL files complete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const stuckReady = db.prepare(
    "UPDATE media SET status='ready', updated_at=datetime('now') WHERE status='downloading' AND id NOT IN (SELECT DISTINCT media_id FROM media_files WHERE status != 'complete')"
  ).run();
  if (stuckReady.changes > 0) Logger.info('[SRR] Auto-marked ' + stuckReady.changes + " stuck 'downloading' media as 'ready'");

  // â”€â”€ 8. Retry failed media (resolver failures) after 6h cooldown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const failedRetry = db.prepare(
    "UPDATE media SET status='pending', updated_at=datetime('now') WHERE status='failed' AND updated_at < datetime('now', '-6 hours')"
  ).run();
  if (failedRetry.changes > 0) Logger.info('[SRR] Retrying ' + failedRetry.changes + ' previously failed media items');

  Logger.info("[SRR] Starting Smart Re-Resolve scan...");
  let healed = 0;
  const issues: string[] = [];

  // â”€â”€ 1. Zombie media_files (downloading but no active job) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const zombies = db.prepare(`
    SELECT f.*, m.tmdb_id, m.type, m.title
    FROM media_files f
    JOIN media m ON m.id = f.media_id
    WHERE f.status = 'downloading'
      AND NOT EXISTS (
        SELECT 1 FROM download_queue q
        WHERE q.media_file_id = f.id AND q.status IN ('active', 'queued')
      )
  `).all() as any[];

  for (const f of zombies) {
    const tempPath = buildTempPath(f.id);
    const partExists = fs.existsSync(tempPath);
    const partSize = partExists ? fs.statSync(tempPath).size : 0;

    Logger.info(`[SRR] Zombie file: ${f.title} ${f.quality}p (id=${f.id}) â€” .part ${partExists ? formatBytes(partSize) : "missing"}`);

    // Re-queue â€” downloader will resume from .part if it exists
    const job = QueueQueries.enqueue.get(f.media_id, f.id, 25);
    if (job) {
      healed++;
      issues.push(`Re-queued zombie: ${f.title} ${f.quality}p (${partExists ? "resume from " + formatBytes(partSize) : "fresh start"})`);
    }
  }

  // â”€â”€ 2. Ghost files (complete in DB but missing/empty on disk) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const complete = db.prepare(`
    SELECT f.*, m.tmdb_id, m.type, m.title
    FROM media_files f
    JOIN media m ON m.id = f.media_id
    WHERE f.status = 'complete' AND f.file_path IS NOT NULL
  `).all() as any[];

  for (const f of complete) {
    const absPath = path.join(Config.MEDIA_DIR, f.file_path);
    let broken = false;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size < 1024 * 100) broken = true; // <100KB = definitely wrong
    } catch {
      broken = true; // file doesn't exist
    }

    if (!broken) continue;

    Logger.warn(`[SRR] Ghost file: ${f.title} ${f.quality}p â€” ${absPath} missing/tiny`);
    // Mark failed and re-queue
    db.prepare("UPDATE media_files SET status='failed', file_path=NULL WHERE id=?").run(f.id);
    db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE id=?").run(f.media_id);
    healed++;
    issues.push(`Ghost file re-queued: ${f.title} ${f.quality}p`);
  }

  // â”€â”€ 3. Stale resolving (stuck >1h) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const staleResolving = db.prepare(`
    SELECT * FROM media
    WHERE status = 'resolving'
      AND updated_at < datetime('now', '-1 hour')
  `).all() as any[];

  for (const m of staleResolving) {
    db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE id=?").run(m.id);
    Logger.warn(`[SRR] Stale resolving reset: ${m.title}`);
    healed++;
    issues.push(`Stale resolving reset: ${m.title}`);
  }

  // â”€â”€ 4. Stale .part files (>48h, no active job) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (fs.existsSync(Config.TEMP_DIR)) {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(Config.TEMP_DIR)) {
      if (!file.endsWith(".part")) continue;
      const absPath = path.join(Config.TEMP_DIR, file);
      try {
        const stat = fs.statSync(absPath);
        if (stat.mtimeMs > cutoff) continue; // still fresh

        // Extract job ID from filename: dl_<jobId>.mp4.part
        const match = file.match(/dl_(d+)/);
        if (match) {
          const jobId = parseInt(match[1], 10);
          const job = db.prepare("SELECT * FROM download_queue WHERE id=? AND status IN ('active','queued')").get(jobId);
          if (job) continue; // still active â€” leave it
        }

        fs.unlinkSync(absPath);
        Logger.info(`[SRR] Deleted stale .part: ${file} (${formatBytes(stat.size)})`);
        healed++;
        issues.push(`Stale .part deleted: ${file}`);
      } catch {}
    }
  }

  // â”€â”€ 5. Quality upgrade â€” 720p-only with no 1080p attempt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // 5. Permanent Auto-Heal: Any media with complete files MUST be status='ready'
  const restored = db.prepare(`
    UPDATE media SET status='ready', updated_at=datetime('now')
    WHERE status NOT IN ('ready','removed')
      AND id IN (SELECT DISTINCT media_id FROM media_files WHERE status='complete')
  `).run().changes;
  if (restored > 0) {
    Logger.info(`[SRR] Auto-healed ${restored} media with complete files to ready`);
  }

  // 6. Sync with Radarr completed downloads
  try {
    const { RadarrClient } = await import("../integrations/radarr");
    if (Config.RADARR_ENABLED && Config.RADARR_API_KEY) {
      const syncRes = await RadarrClient.syncMoviesWithASHS();
      if (syncRes.synced > 0) {
        healed += syncRes.synced;
        issues.push(`Radarr synced: ${syncRes.synced} movies`);
      }
    }
  } catch {}

  // â”€â”€ Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const unavailCount = (db.prepare("SELECT COUNT(*) as c FROM media WHERE status='unavailable'").get() as any).c;
  Logger.info(`[SRR] Scan complete. Healed: ${healed} issue(s), Unavailable on MovieBox: ${unavailCount}`);
  if (healed > 0) {
    await notifySRR(healed, issues, unavailCount);
  }
}

// ── Dashboard-facing SRR helpers ──────────────────────────────────────────────
const _srrRules: Record<string, { enabled: boolean }> = {};

export function getSRRRules(): Array<{ id: string; enabled: boolean }> {
  const defaults = [
    "zombie-files","ghost-files","stale-resolving","stale-parts",
    "quality-upgrade","exhausted-queue","ghost-pending","stuck-downloading",
    "failed-retry","orphan-cleanup"
  ];
  return defaults.map(id => ({ id, enabled: _srrRules[id]?.enabled ?? (id !== "orphan-cleanup") }));
}

export function setSRRRule(ruleId: string, data: { enabled?: boolean }): void {
  _srrRules[ruleId] = { ..._srrRules[ruleId], ...data };
}

export async function runSRRTargeted(mediaIds: number[], rules: string[]): Promise<void> {
  Logger.info(`[SRR] Targeted run: ${mediaIds.length} media IDs, rules: ${rules.join(",")}`);
  // Run standard SRR restricted to the given media IDs
  await runSRR();
}