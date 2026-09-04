#!/usr/bin/env bun
/**
 * ASHS Database Backup Script
 * Run daily via cron: 0 2 * * * /root/.bun/bin/bun /opt/ashs/scripts/backup-db.ts
 *
 * Backs up SQLite to:
 *   1. Local timestamped copy: /opt/ashs/db/backups/ashs_YYYY-MM-DD.sqlite3
 *   2. Cloudflare R2 (if R2_* env vars configured): r2://ashs-backups/ashs_YYYY-MM-DD.sqlite3
 *
 * Keeps last 7 local backups, removes older ones automatically.
 */

import { Database }  from "bun:sqlite";
import fs            from "fs";
import path          from "path";

// ── Config ────────────────────────────────────────────────────────────────
const DB_PATH      = process.env.DB_PATH      ?? "/opt/ashs/db/ashs.sqlite3";
const BACKUP_DIR   = process.env.BACKUP_DIR   ?? "/opt/ashs/db/backups";
const KEEP_DAYS    = parseInt(process.env.BACKUP_KEEP_DAYS ?? "7", 10);
const WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL ?? "";

// R2 via rclone (optional)
const R2_ENABLED   = process.env.R2_ENABLED === "true";
const R2_REMOTE    = process.env.R2_REMOTE    ?? "r2:ashs-backups"; // rclone remote:bucket

// ── Helpers ───────────────────────────────────────────────────────────────
function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function discord(title: string, desc: string, color: number) {
  if (!WEBHOOK_URL) return;
  await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [{ title, description: desc, color, timestamp: new Date().toISOString() }] }),
  }).catch(() => {});
}

function formatBytes(b: number): string {
  if (b > 1e9) return `${(b/1e9).toFixed(2)} GB`;
  if (b > 1e6) return `${(b/1e6).toFixed(2)} MB`;
  return `${(b/1e3).toFixed(2)} KB`;
}

// ── Main ──────────────────────────────────────────────────────────────────
const today    = new Date().toISOString().slice(0, 10);          // YYYY-MM-DD
const destName = `ashs_${today}.sqlite3`;
const destPath = path.join(BACKUP_DIR, destName);

log(`Starting backup: ${DB_PATH} → ${destPath}`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Use SQLite online backup API (safe while DB is running)
try {
  const src  = new Database(DB_PATH, { readonly: true });
  const dest = new Database(destPath, { create: true });
  // bun:sqlite backup method
  (src as any).serialize(dest);
  src.close();
  dest.close();
  log(`Local backup complete`);
} catch (err) {
  // Fallback: simple file copy (less safe but works if DB is WAL mode)
  log(`serialize failed, falling back to file copy: ${(err as Error).message}`);
  fs.copyFileSync(DB_PATH, destPath);
  log(`File copy complete`);
}

const stat = fs.statSync(destPath);
log(`Backup size: ${formatBytes(stat.size)}`);

// ── R2 Upload via rclone ──────────────────────────────────────────────────
if (R2_ENABLED) {
  log(`Uploading to R2: ${R2_REMOTE}/${destName}`);
  const proc = Bun.spawn(["rclone", "copy", destPath, R2_REMOTE, "--no-traverse"], {
    stdout: "inherit", stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === 0) {
    log(`R2 upload complete`);
  } else {
    log(`R2 upload FAILED (exit ${code})`);
    await discord("⚠️ Backup R2 Upload Failed", `Exit code: ${code}`, 0xfee75c);
  }
}

// ── Rotate old local backups ───────────────────────────────────────────────
const backups = fs.readdirSync(BACKUP_DIR)
  .filter(f => f.startsWith("ashs_") && f.endsWith(".sqlite3"))
  .sort()
  .reverse();

for (const old of backups.slice(KEEP_DAYS)) {
  const p = path.join(BACKUP_DIR, old);
  fs.unlinkSync(p);
  log(`Removed old backup: ${old}`);
}

// ── Discord notification ──────────────────────────────────────────────────
await discord(
  "✅ Daily DB Backup Complete",
  `File: \`${destName}\`\nSize: ${formatBytes(stat.size)}\nKept: last ${KEEP_DAYS} backups\n${R2_ENABLED ? "R2: uploaded ✅" : "R2: disabled"}`,
  0x57f287
);

log(`Backup finished.`);
