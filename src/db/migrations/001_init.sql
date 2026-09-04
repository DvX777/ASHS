-- Migration 001: Initial schema
-- Run via: bun run migrate

-- ── Media index ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id         TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('movie', 'tv')),
  title           TEXT NOT NULL,
  original_title  TEXT,
  year            INTEGER,
  poster_path     TEXT,
  backdrop_path   TEXT,
  overview        TEXT,
  genres          TEXT,             -- JSON: ["Action","Comedy"]
  popularity      REAL DEFAULT 0,
  vote_average    REAL DEFAULT 0,
  vote_count      INTEGER DEFAULT 0,
  runtime         INTEGER DEFAULT 0,-- minutes (movies only)
  original_language TEXT,           -- TMDB language code e.g. "en","hi","ko"
  stored_language TEXT,             -- Actual language of downloaded files
  status          TEXT NOT NULL DEFAULT 'pending',
  -- status: pending | resolving | downloading | ready | partial | failed | removed
  moviebox_id     TEXT,             -- MovieBox internal subject ID (for re-resolving)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tmdb_id, type)
);
CREATE INDEX IF NOT EXISTS idx_media_status ON media(status);
CREATE INDEX IF NOT EXISTS idx_media_type_pop ON media(type, popularity DESC);
CREATE INDEX IF NOT EXISTS idx_media_title ON media(title);

-- ── Individual media files ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  season          INTEGER NOT NULL DEFAULT 0,  -- 0 for movies
  episode         INTEGER NOT NULL DEFAULT 0,  -- 0 for movies
  quality         INTEGER NOT NULL,            -- 720, 1080
  language        TEXT NOT NULL DEFAULT 'Original',
  format          TEXT NOT NULL DEFAULT 'mp4' CHECK (format IN ('mp4', 'hls')),
  file_path       TEXT,                        -- relative: movie/533535/1080p.mp4
  file_size       INTEGER DEFAULT 0,           -- bytes
  duration        INTEGER DEFAULT 0,           -- seconds
  checksum_sha256 TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  -- status: queued | downloading | complete | failed | retrying | removed
  progress        REAL NOT NULL DEFAULT 0,     -- 0.0 to 1.0
  retry_count     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  UNIQUE(media_id, season, episode, quality, language)
);
CREATE INDEX IF NOT EXISTS idx_files_status ON media_files(status);
CREATE INDEX IF NOT EXISTS idx_files_media ON media_files(media_id);

-- ── TV seasons ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seasons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  season_number   INTEGER NOT NULL,
  episode_count   INTEGER DEFAULT 0,
  name            TEXT,
  air_date        TEXT,
  UNIQUE(media_id, season_number)
);

-- ── Download queue ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS download_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  media_file_id   INTEGER REFERENCES media_files(id) ON DELETE CASCADE,
  priority        INTEGER NOT NULL DEFAULT 50, -- 0=highest, 100=lowest
  status          TEXT NOT NULL DEFAULT 'queued',
  -- status: queued | active | done | failed | cancelled
  source_url      TEXT,             -- MovieBox CDN URL (expires in ~2h)
  source_headers  TEXT,             -- JSON: { origin, referer, user-agent }
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  scheduled_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  completed_at    TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON download_queue(status, priority ASC, scheduled_at ASC);

-- ── Approved websites ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approved_sites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  domain          TEXT NOT NULL UNIQUE,
  api_key         TEXT NOT NULL UNIQUE,
  name            TEXT,
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 120,
  enabled         INTEGER NOT NULL DEFAULT 1,  -- SQLite uses 0/1 for bool
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Access logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id         INTEGER REFERENCES approved_sites(id),
  method          TEXT,
  path            TEXT,
  status_code     INTEGER,
  response_ms     INTEGER,
  bytes_sent      INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON access_logs(created_at DESC);
