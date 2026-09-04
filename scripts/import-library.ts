// scripts/import-library.ts
// Transfers an existing Radarr/Jellyfin library into ASHS.
//
// Usage:
//   bun run scripts/import-library.ts /path/to/jellyfin/movies [--move | --copy]
//
// Folder name formats supported:
//   Movie Title (2008)
//   Movie Title (2008) {tmdb-12345}
//   Movie Title (2008) [tmdb-12345]

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";

const TMDB_KEY  = process.env.TMDB_API_KEY ?? "439c478a771f35c05022f9feabcca01c";
const DB_PATH   = process.env.DB_PATH   ?? "./ashs.sqlite3";
const MEDIA_DIR = process.env.MEDIA_DIR ?? "./media";
const SOURCE_DIR = process.argv[2];
const MODE       = process.argv.includes("--copy") ? "copy" : "move"; // default: move

if (!SOURCE_DIR) {
  console.error("Usage: bun run scripts/import-library.ts <source-dir> [--move|--copy]");
  console.error("Example: bun run scripts/import-library.ts /media/jellyfin/Movies --move");
  process.exit(1);
}

if (!existsSync(SOURCE_DIR)) {
  console.error("Source directory does not exist: " + SOURCE_DIR);
  process.exit(1);
}

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".webm"]);

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

let imported = 0, skipped = 0, failed = 0;

console.log("=".repeat(60));
console.log("  ASHS Library Importer");
console.log("  Source:  " + SOURCE_DIR);
console.log("  Mode:    " + MODE.toUpperCase());
console.log("  Media:   " + MEDIA_DIR);
console.log("=".repeat(60) + "\n");

// ── TMDB helpers ──────────────────────────────────────────────────────────────
async function tmdbSearchMovie(title: string, year: string): Promise<any | null> {
  const q   = encodeURIComponent(title);
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}&year=${year}&language=en-US`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json() as any;
    return json?.results?.[0] ?? null;
  } catch { return null; }
}

async function tmdbMovieDetail(id: number): Promise<any | null> {
  try {
    const res  = await fetch(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}`, { signal: AbortSignal.timeout(8000) });
    return await res.json() as any;
  } catch { return null; }
}

// ── Parse folder name ─────────────────────────────────────────────────────────
function parseFolderName(name: string): { title: string; year: string; tmdbId: string | null } {
  // {tmdb-12345} or [tmdb-12345]
  const tmdbMatch = name.match(/[{\[]tmdb-?(\d+)[}\]]/i);
  const tmdbId    = tmdbMatch ? tmdbMatch[1] : null;

  // "Movie Title (2008)" or "Movie Title 2008"
  const yearMatch = name.match(/\((\d{4})\)/) ?? name.match(/(\d{4})/);
  const year      = yearMatch ? yearMatch[1] : "";

  // Title: everything before the year
  let title = name
    .replace(/[{\[]tmdb-?\d+[}\]]/gi, "")
    .replace(/\(\d{4}\).*/, "")
    .replace(/\d{4}.*/, "")
    .replace(/[._\-]+/g, " ")
    .trim();

  return { title, year, tmdbId };
}

// ── Find video files in a folder ──────────────────────────────────────────────
function findVideoFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      const stat = statSync(full);
      if (stat.isDirectory()) files.push(...findVideoFiles(full));
      else if (VIDEO_EXTS.has(extname(f).toLowerCase())) files.push(full);
    }
  } catch {}
  return files;
}

// ── Detect quality from filename ──────────────────────────────────────────────
function detectQuality(filename: string): number {
  const f = filename.toLowerCase();
  if (f.includes("2160") || f.includes("4k") || f.includes("uhd")) return 2160;
  if (f.includes("1080"))  return 1080;
  if (f.includes("720"))   return 720;
  if (f.includes("480"))   return 480;
  return 720; // default assumption
}

// ── Register file in DB ───────────────────────────────────────────────────────
function registerInDb(detail: any, relPath: string, quality: number, fileSize: number): void {
  const tmdbId = String(detail.id);
  const genres = JSON.stringify((detail.genres ?? []).map((g: any) => g.name));
  const year   = parseInt((detail.release_date ?? "").slice(0, 4)) || null;

  // Upsert media row
  db.run(`
    INSERT INTO media (tmdb_id, type, title, original_title, year, poster_path, backdrop_path,
      overview, genres, popularity, vote_average, vote_count, runtime, original_language, stored_language, status)
    VALUES (?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', 'ready')
    ON CONFLICT(tmdb_id, type) DO UPDATE SET
      status = 'ready', popularity = excluded.popularity, updated_at = datetime('now')
  `, [
    tmdbId, detail.title, detail.original_title ?? null, year,
    detail.poster_path ?? null, detail.backdrop_path ?? null, detail.overview ?? null,
    genres, detail.popularity ?? 0, detail.vote_average ?? 0, detail.vote_count ?? 0,
    detail.runtime ?? 0, detail.original_language ?? "en",
  ]);

  const mediaRow = db.query<{ id: number }, [string]>("SELECT id FROM media WHERE tmdb_id = ? AND type = 'movie' LIMIT 1").get(tmdbId);
  if (!mediaRow) return;

  // Upsert file row
  db.run(`
    INSERT INTO media_files (media_id, season, episode, quality, language, format, file_path, file_size, status, progress)
    VALUES (?, 0, 0, ?, 'imported', 'mp4', ?, ?, 'complete', 1.0)
    ON CONFLICT(media_id, season, episode, quality, language) DO UPDATE SET
      file_path = excluded.file_path, file_size = excluded.file_size, status = 'complete'
  `, [mediaRow.id, quality, relPath, fileSize]);
}

// ── Main import loop ──────────────────────────────────────────────────────────
const entries = readdirSync(SOURCE_DIR);
console.log("Found " + entries.length + " entries in source directory\n");

for (const entry of entries) {
  const entryPath = join(SOURCE_DIR, entry);
  const stat      = statSync(entryPath);

  // Support both: folder-per-movie OR flat files
  const videoFiles = stat.isDirectory()
    ? findVideoFiles(entryPath)
    : VIDEO_EXTS.has(extname(entry).toLowerCase()) ? [entryPath] : [];

  if (!videoFiles.length) { skipped++; continue; }

  const { title, year, tmdbId: parsedTmdbId } = parseFolderName(stat.isDirectory() ? entry : entry.replace(/\.[^.]+$/, ""));

  if (!title) { console.log("  SKIP (no title): " + entry); skipped++; continue; }

  process.stdout.write("→ " + title + " (" + year + ") ... ");

  // Resolve TMDB
  let detail: any = null;
  if (parsedTmdbId) {
    detail = await tmdbMovieDetail(parseInt(parsedTmdbId));
  }
  if (!detail) {
    const result = await tmdbSearchMovie(title, year);
    if (result) detail = await tmdbMovieDetail(result.id);
  }

  if (!detail?.id) {
    console.log("❌ TMDB not found");
    failed++;
    continue;
  }

  const tmdbId = String(detail.id);

  // Check if already imported
  const existing = db.query<{ status: string }, [string]>("SELECT status FROM media WHERE tmdb_id = ? AND type = 'movie' LIMIT 1").get(tmdbId);
  if (existing?.status === "ready") {
    console.log("⏭  already in library (" + detail.title + ")");
    skipped++;
    continue;
  }

  // For each video file found, pick the best quality one (or import all)
  for (const videoFile of videoFiles) {
    const quality  = detectQuality(basename(videoFile));
    const fileSize = statSync(videoFile).size;
    const destRel  = join("movie", tmdbId, quality + "p.mp4");
    const destAbs  = join(MEDIA_DIR, destRel);

    mkdirSync(dirname(destAbs), { recursive: true });

    try {
      if (MODE === "move") {
        try {
          renameSync(videoFile, destAbs);          // fast (same fs)
        } catch {
          copyFileSync(videoFile, destAbs);         // fallback: cross-device
          unlinkSync(videoFile);
        }
      } else {
        copyFileSync(videoFile, destAbs);
      }

      registerInDb(detail, destRel.replace(/\\/g, "/"), quality, fileSize);
      console.log("✅ " + detail.title + " [" + quality + "p] → " + destRel);
      imported++;
    } catch (err) {
      console.log("❌ transfer failed: " + (err as Error).message);
      failed++;
    }
  }
}

db.close();

console.log("\n" + "=".repeat(60));
console.log("  Import complete");
console.log("  Imported: " + imported);
console.log("  Skipped:  " + skipped);
console.log("  Failed:   " + failed);
console.log("=".repeat(60));