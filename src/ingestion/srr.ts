// src/ingestion/srr.ts — Smart Re-Resolve: heals broken downloads + quality upgrades
import fs from "fs";
import path from "path";
import { db, MediaQueries, FileQueries, QueueQueries } from "../db";
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { Discord } from "../utils/discord";
import { buildTempPath, buildRelativePath } from "../storage/paths";
import { formatBytes } from "../utils/helpers";

/**
 * SRR runs on startup and every 6h.
 * It detects and heals 5 types of broken state:
 *
 *  1. Zombie media_files — status='downloading' with no active queue job
 *     → re-create the queue job (downloader will resume the .part file)
 *
 *  2. Ghost files — status='complete' but file missing/empty on disk
 *     → mark failed, re-queue so it downloads fresh
 *
 *  3. Stale resolving — media stuck in status='resolving' for >1h
 *     → reset to 'pending' so it gets re-resolved next tick
 *
 *  4. Stale .part files — .part files >48h old with no active queue job
 *     → delete them to free NVMe space
 *
 *  5. Quality upgrade — media with only 720p, never attempted 1080p
 *     → re-queue for resolving (will try 1080p next time)
 */
export async function runSRR(): Promise<void> {
  Logger.info("[SRR] Starting Smart Re-Resolve scan...");
  let healed = 0;
  const issues: string[] = [];

  // ── 1. Zombie media_files (downloading but no active job) ──────────────────
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

    Logger.info(`[SRR] Zombie file: ${f.title} ${f.quality}p (id=${f.id}) — .part ${partExists ? formatBytes(partSize) : "missing"}`);

    // Re-queue — downloader will resume from .part if it exists
    const job = QueueQueries.enqueue.get(f.media_id, f.id, 25);
    if (job) {
      healed++;
      issues.push(`Re-queued zombie: ${f.title} ${f.quality}p (${partExists ? "resume from " + formatBytes(partSize) : "fresh start"})`);
    }
  }

  // ── 2. Ghost files (complete in DB but missing/empty on disk) ─────────────
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

    Logger.warn(`[SRR] Ghost file: ${f.title} ${f.quality}p — ${absPath} missing/tiny`);
    // Mark failed and re-queue
    db.prepare("UPDATE media_files SET status='failed', file_path=NULL WHERE id=?").run(f.id);
    db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE id=?").run(f.media_id);
    healed++;
    issues.push(`Ghost file re-queued: ${f.title} ${f.quality}p`);
  }

  // ── 3. Stale resolving (stuck >1h) ────────────────────────────────────────
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

  // ── 4. Stale .part files (>48h, no active job) ───────────────────────────
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
          if (job) continue; // still active — leave it
        }

        fs.unlinkSync(absPath);
        Logger.info(`[SRR] Deleted stale .part: ${file} (${formatBytes(stat.size)})`);
        healed++;
        issues.push(`Stale .part deleted: ${file}`);
      } catch {}
    }
  }

  // ── 5. Quality upgrade — 720p-only with no 1080p attempt ─────────────────
  const upgradeTargets = db.prepare(`
    SELECT DISTINCT m.id, m.title, m.tmdb_id, m.type
    FROM media m
    JOIN media_files f ON f.media_id = m.id
    WHERE m.status = 'ready'
      AND f.quality = 720
      AND f.status = 'complete'
      AND NOT EXISTS (
        SELECT 1 FROM media_files f2
        WHERE f2.media_id = m.id AND f2.quality = 1080
      )
    LIMIT 20
  `).all() as any[];

  for (const m of upgradeTargets) {
    // Check if 1080p file exists on disk (shouldn't if DB says no 1080p)
    const relPath = buildRelativePath(m.type, m.tmdb_id, 1080, 0, 0);
    const absPath = path.join(Config.MEDIA_DIR, relPath);
    if (fs.existsSync(absPath)) continue;

    // Reset to downloading so manager will re-resolve and try 1080p
    db.prepare("UPDATE media SET status='pending', updated_at=datetime('now') WHERE id=?").run(m.id);
    Logger.info(`[SRR] Quality upgrade queued: ${m.title} (needs 1080p)`);
    healed++;
    issues.push(`Quality upgrade: ${m.title}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  Logger.info(`[SRR] Scan complete. Healed: ${healed} issue(s)`);
  if (healed > 0) {
    await Discord.warning(
      "🔧 SRR: Issues Detected & Healed",
      issues.slice(0, 10).join("\n") + (issues.length > 10 ? `\n...and ${issues.length - 10} more` : "")
    );
  }
}
