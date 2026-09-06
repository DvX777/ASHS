// src/db/index.ts â€” SQLite via bun:sqlite (zero native deps)
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Config } from "../config";
import { Logger } from "../utils/logger";

const _dbDir = dirname(Config.DB_PATH); if (_dbDir && _dbDir !== '.') mkdirSync(_dbDir, { recursive: true });

export const db = new Database(Config.DB_PATH, { create: true });

db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA cache_size = -32000");

export interface Media {
  id: number; tmdb_id: string; type: string; title: string; original_title: string | null;
  year: number | null; poster_path: string | null; backdrop_path: string | null;
  overview: string | null; genres: string | null; popularity: number; vote_average: number;
  vote_count: number; runtime: number; original_language: string | null;
  stored_language: string | null; status: string; moviebox_id: string | null;
  created_at: string; updated_at: string;
}

export interface MediaFile {
  id: number; media_id: number; season: number; episode: number; quality: number;
  language: string; format: string; file_path: string | null; file_size: number;
  duration: number; checksum_sha256: string | null; status: string; progress: number;
  retry_count: number; error: string | null; created_at: string; completed_at: string | null;
}

export interface DownloadJob {
  id: number; media_id: number; media_file_id: number | null; priority: number; status: string;
  source_url: string | null; source_headers: string | null; attempts: number; max_attempts: number;
  scheduled_at: string; started_at: string | null; completed_at: string | null; error: string | null;
}

export interface ApprovedSite {
  id: number; domain: string; api_key: string; name: string | null;
  rate_limit_rpm: number; enabled: number; created_at: string;
}

export const MediaQueries = {
  findByTmdb: db.query<Media, [string, string]>("SELECT * FROM media WHERE tmdb_id = ? AND type = ? LIMIT 1"),
  listReady:  db.query<Media, [string, number, number]>("SELECT * FROM media WHERE type = ? AND status = 'ready' ORDER BY popularity DESC LIMIT ? OFFSET ?"),
  recent:     db.query<Media, [number]>("SELECT * FROM media WHERE status = 'ready' ORDER BY updated_at DESC LIMIT ?"),
  setStatus:  db.query<null, [string, string, string]>("UPDATE media SET status = ?, updated_at = datetime('now') WHERE tmdb_id = ? AND type = ?"),
};

export const FileQueries = {
  forMedia:         db.query<MediaFile, [number]>("SELECT * FROM media_files WHERE media_id = ? ORDER BY quality DESC"),
  forEpisode:       db.query<MediaFile, [number, number, number]>("SELECT * FROM media_files WHERE media_id = ? AND season = ? AND episode = ? ORDER BY quality DESC"),
  setStatus:        db.query<null, [string, string | null, number]>("UPDATE media_files SET status = ?, error = ? WHERE id = ?"),
  updateProgress:   db.query<null, [number, number]>("UPDATE media_files SET progress = ? WHERE id = ?"),
  // readyCheck: ready when >= 1 file complete AND no jobs still active/queued/pending
  // Fixes: SRR quality upgrade fails -> 480p done + 1080p failed -> stays stuck as downloading
  readyCheck: db.query<{ should_be_ready: number }, [number]>(`
    SELECT ((SELECT COUNT(*) FROM media_files WHERE media_id=? AND status='complete') > 0) as should_be_ready
  `),
  allComplete:      db.query<{ all_done: number }, [number]>("SELECT (COUNT(*) = SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END)) as all_done FROM media_files WHERE media_id = ?"),
  findByChecksum:   db.query<MediaFile, [string]>("SELECT * FROM media_files WHERE checksum_sha256 = ? AND status = 'complete' LIMIT 1"),
  insertFile: db.query<{ id: number }, [number, number, number, number, string, string, string | null]>("INSERT INTO media_files (media_id, season, episode, quality, language, format, file_path) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id"),
  complete: db.query<null, [string, number, string | null, number, number]>("UPDATE media_files SET status='complete', file_path=?, file_size=?, checksum_sha256=?, duration=?, completed_at=datetime('now'), progress=1.0 WHERE id=?"),
};

export const QueueQueries = {
  enqueue: db.query<{ id: number }, [number, number | null, number]>("INSERT INTO download_queue (media_id, media_file_id, priority) VALUES (?, ?, ?) RETURNING id"),
  nextQueued:  db.query<any, []>(`SELECT q.*, m.tmdb_id, m.type, m.title, f.season, f.episode, f.quality, f.language FROM download_queue q JOIN media m ON m.id = q.media_id LEFT JOIN media_files f ON f.id = q.media_file_id WHERE q.status = 'queued' AND q.attempts < q.max_attempts ORDER BY q.priority ASC, q.scheduled_at ASC LIMIT 1`),
  countActive: db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM download_queue WHERE status = 'active'"),
  markActive:  db.query<null, [number]>("UPDATE download_queue SET status='active', started_at=datetime('now'), attempts=attempts+1 WHERE id=?"),
  markDone:    db.query<null, [number]>("UPDATE download_queue SET status='done', completed_at=datetime('now') WHERE id=?"),
  markFailed:  db.query<null, [string, number]>("UPDATE download_queue SET status='failed', error=? WHERE id=?"),
  requeueFailed: db.query<null, [number]>("UPDATE download_queue SET status='queued', scheduled_at=datetime('now', '+5 minutes'), max_attempts=MAX(max_attempts, attempts+1) WHERE id=?"),
  list:        db.query<DownloadJob, [number, number]>("SELECT * FROM download_queue ORDER BY priority ASC, scheduled_at ASC LIMIT ? OFFSET ?"),
  cancel:      db.query<null, [number]>("UPDATE download_queue SET status='cancelled' WHERE id=? AND status='queued'"),
  stats:       db.query<{ status: string; count: number }, []>("SELECT status, COUNT(*) as count FROM download_queue GROUP BY status"),
};

export const SiteQueries = {
  insert: db.query<{ id: number }, [string, string, string | null, number]>("INSERT INTO approved_sites (domain, api_key, name, rate_limit_rpm) VALUES (?, ?, ?, ?) RETURNING id"),
  findByDomain: db.query<ApprovedSite, [string]>("SELECT * FROM approved_sites WHERE domain = ? AND enabled = 1 LIMIT 1"),
  list:         db.query<ApprovedSite, []>("SELECT * FROM approved_sites ORDER BY created_at DESC"),
  disable:      db.query<null, [number]>("UPDATE approved_sites SET enabled = 0 WHERE id = ?"),
};

Logger.info(`[DB] Connected: ${Config.DB_PATH}`);

