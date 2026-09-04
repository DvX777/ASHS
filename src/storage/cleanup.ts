// src/storage/cleanup.ts - Auto-delete stale content when disk is near full
import fs from 'fs';
import path from 'path';
import { db, FileQueries } from '../db';
import { Config } from '../config';
import { Logger } from '../utils/logger';
import { Discord } from '../utils/discord';
import { getDiskStats, formatDiskStats } from './stats';
import { resolveMediaPath } from './paths';
import { formatBytes } from '../utils/helpers';

export function removeMediaFile(fileId: number, filePath: string): void {
  const abs = resolveMediaPath(filePath);
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch {}
  FileQueries.setStatus.run('removed', null, fileId);
  Logger.info('[Cleanup] Removed file ID ' + fileId + ': ' + filePath);
}

export function cleanTempDir(): void {
  const tempDir = Config.TEMP_DIR;
  if (!fs.existsSync(tempDir)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const file of fs.readdirSync(tempDir)) {
    if (!file.endsWith('.part')) continue;
    const abs = path.join(tempDir, file);
    try { if (fs.statSync(abs).mtimeMs < cutoff) { fs.unlinkSync(abs); cleaned++; } } catch {}
  }
  if (cleaned > 0) Logger.info('[Cleanup] Removed ' + cleaned + ' stale temp files');
}

export async function runCleanupIfNeeded(): Promise<void> {
  const stats = getDiskStats(Config.MEDIA_DIR);
  if (stats.percent < Config.DISK_CLEANUP_THRESHOLD) return;
  Logger.warn('[Cleanup] Disk at ' + (stats.percent * 100).toFixed(1) + '% -- starting cleanup');
  await Discord.warning('Disk Cleanup Triggered', 'HDD usage: ' + formatDiskStats(stats));
  const candidates = db.query<any, []>('SELECT f.id, f.file_path, f.file_size, m.popularity FROM media_files f JOIN media m ON m.id = f.media_id WHERE f.quality = 720 AND f.status = ' + "'complete'" + ' AND f.file_path IS NOT NULL ORDER BY m.popularity ASC LIMIT 50').all();
  let freed = 0;
  for (const file of candidates) {
    removeMediaFile(file.id, file.file_path);
    freed += file.file_size;
    if (getDiskStats(Config.MEDIA_DIR).percent < Config.DISK_CLEANUP_THRESHOLD - 0.05) break;
  }
  Logger.info('[Cleanup] Freed ' + formatBytes(freed));
  await Discord.success('Cleanup Complete', 'Freed ' + formatBytes(freed));
}