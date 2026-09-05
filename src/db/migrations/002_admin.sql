-- Migration 002: Admin dashboard tables

-- Admin sessions (cookie auth)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON admin_sessions(expires_at);

-- SRR run history
CREATE TABLE IF NOT EXISTS srr_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type     TEXT NOT NULL DEFAULT 'scheduled',
  target_id    INTEGER,
  target_title TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms  INTEGER,
  issues_found INTEGER NOT NULL DEFAULT 0,
  issues_fixed INTEGER NOT NULL DEFAULT 0,
  details      TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_srr_history_started ON srr_history(started_at DESC);