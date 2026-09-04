// src/storage/stats.ts — Disk usage monitoring (cross-platform)
import { execSync } from 'child_process';
import { Config } from '../config';
import { Logger } from '../utils/logger';
import { formatBytes } from '../utils/helpers';

export interface DiskStats {
  total: number; used: number; free: number; percent: number;
}

export function getDiskStats(dirPath: string): DiskStats {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      // Windows: use wmic or just return mock for local dev
      const drive = dirPath.match(/^([A-Za-z]):/)?.[1] ?? 'C';
      const out = execSync('wmic logicaldisk where DeviceID=' + "''" + drive + ':' + "''" + ' get FreeSpace,Size /format:csv', { encoding: 'utf-8' });
      const lines = out.trim().split('\n').filter(l => l.includes(','));
      const last = lines[lines.length - 1]?.split(',') ?? [];
      const free  = parseInt(last[1] ?? '0', 10) || 0;
      const total = parseInt(last[2] ?? '0', 10) || 0;
      const used  = total - free;
      return { total, used, free, percent: total > 0 ? used / total : 0 };
    } else {
      const out   = execSync('df -B1 ' + '"' + dirPath + '"', { encoding: 'utf-8' });
      const parts = out.trim().split('\n').pop()?.split(/\s+/) ?? [];
      const total = parseInt(parts[1] ?? '0', 10);
      const used  = parseInt(parts[2] ?? '0', 10);
      const free  = parseInt(parts[3] ?? '0', 10);
      return { total, used, free, percent: total > 0 ? used / total : 0 };
    }
  } catch (err) {
    Logger.warn('[Storage] Disk stats unavailable for ' + dirPath + ': ' + (err as Error).message);
    return { total: 0, used: 0, free: 0, percent: 0 };
  }
}

export const getMediaStats = () => getDiskStats(Config.MEDIA_DIR);
export const getTempStats  = () => getDiskStats(Config.TEMP_DIR);
export const isDiskCritical = () => getMediaStats().percent >= Config.DISK_CLEANUP_THRESHOLD;
export const formatDiskStats = (s: DiskStats) => formatBytes(s.used) + ' / ' + formatBytes(s.total) + ' (' + (s.percent * 100).toFixed(1) + '% used)';