// scripts/verify-streaming-and-radarr.ts - Comprehensive Streaming & Radarr Endpoints Verification
import fs from "fs";
import path from "path";
import { Config } from "../src/config";
import { Logger } from "../src/utils/logger";
import { db, MediaQueries, FileQueries } from "../src/db";
import { RadarrClient } from "../src/integrations/radarr";
import { encodeStreamToken } from "../src/utils/streamToken";
import { resolveMediaPath } from "../src/storage/paths";

function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

async function testHead(url: string): Promise<{ ok: boolean; status: number; rangeOk: boolean; size: number; contentType: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
      signal: AbortSignal.timeout(8000),
    });
    const rangeOk = res.status === 206;
    const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
    const cr = res.headers.get("content-range") ?? "";
    const ct = res.headers.get("content-type") ?? "";
    const totalMatch = cr.match(/\/(\d+)$/);
    const totalSize = totalMatch ? parseInt(totalMatch[1], 10) : cl;
    return { ok: res.ok || rangeOk, status: res.status, rangeOk, size: totalSize, contentType: ct };
  } catch (err: any) {
    return { ok: false, status: 0, rangeOk: false, size: 0, contentType: err.message };
  }
}

async function main() {
  console.log("\n=====================================================");
  console.log("  ASHS & RADARR STREAMING PIPELINE VERIFICATION");
  console.log("=====================================================\n");

  // 1. Sync Radarr downloaded movies with ASHS database
  console.log("[1/4] Reconciling Radarr downloads with ASHS database...");
  if (Config.RADARR_ENABLED && Config.RADARR_API_KEY) {
    try {
      const syncResult = await RadarrClient.syncMoviesWithASHS();
      console.log(`      Synced ${syncResult.synced} movies from Radarr into ASHS.`);
    } catch (e: any) {
      console.log(`      Sync notice: ${e.message}`);
    }
  }

  // 2. Query ready movies with completed files
  console.log("[2/4] Querying ready movie library...");
  const movies = db.prepare(`
    SELECT m.id, m.tmdb_id, m.title, m.year, f.id as file_id, f.file_path, f.file_size, f.quality, f.format
    FROM media m
    JOIN media_files f ON f.media_id = m.id
    WHERE m.type = 'movie'
      AND m.status = 'ready'
      AND f.status = 'complete'
      AND f.file_path IS NOT NULL
    ORDER BY m.updated_at DESC
    LIMIT 30
  `).all() as any[];

  console.log(`      Found ${movies.length} sample ready movies to test.\n`);

  if (movies.length === 0) {
    console.log("No completed movie files found in database.");
    process.exit(0);
  }

  // 3. Test on disk existence and local streaming
  console.log("[3/4] Testing On-Disk Paths & HTTP Range Streaming:\n");
  console.log("TMDB ID  " + "Title".padEnd(30) + " Quality  " + "Disk File".padEnd(10) + " Local (206)".padEnd(14) + " Public (206)");
  console.log("-".repeat(95));

  let passDisk = 0;
  let passLocal = 0;
  let passPublic = 0;
  const samplesToPrintUrls: any[] = [];

  for (const m of movies) {
    const tmdbId = String(m.tmdb_id);
    const titleTrunc = (m.title || "Untitled").slice(0, 28).padEnd(30);
    const qual = `${m.quality || 1080}p`.padEnd(9);

    // Test on disk
    const absPath = resolveMediaPath(m.file_path);
    const exists = fs.existsSync(absPath) && fs.statSync(absPath).size > 1024 * 100;
    const diskStatus = exists ? "[EXISTS]" : "[MISSING]";
    if (exists) passDisk++;

    // Generate stream tokens
    const token = encodeStreamToken("movie", tmdbId, m.quality || 1080);
    const localUrl = `http://127.0.0.1:4000/v1/s/${token}`;
    const publicUrl = `https://primeshow.online/v1/s/${token}`;
    const directUrl = `http://127.0.0.1:4000/v1/stream/movie/${tmdbId}`;

    // Test Local Range Request
    const localTest = await testHead(localUrl);
    const localStr = localTest.rangeOk ? `[OK: ${localTest.status}]` : `[FAIL: ${localTest.status}]`;
    if (localTest.rangeOk) passLocal++;

    // Test Public Range Request
    const pubTest = await testHead(publicUrl);
    const pubStr = pubTest.rangeOk ? `[OK: ${pubTest.status}]` : `[HTTP ${pubTest.status}]`;
    if (pubTest.rangeOk) passPublic++;

    console.log(
      tmdbId.padEnd(9) +
      titleTrunc +
      qual +
      diskStatus.padEnd(10) +
      localStr.padEnd(14) +
      pubStr
    );

    if (samplesToPrintUrls.length < 3 && exists && localTest.rangeOk) {
      samplesToPrintUrls.push({
        title: m.title,
        year: m.year,
        quality: m.quality,
        size: fmtBytes(m.file_size),
        path: m.file_path,
        streamUrl: publicUrl,
        directUrl,
      });
    }
  }

  console.log("\n" + "=".repeat(95));
  console.log(`SUMMARY: ${passDisk}/${movies.length} Files On Disk | ${passLocal}/${movies.length} Local Streaming OK | ${passPublic}/${movies.length} Public Streaming OK`);
  console.log("=".repeat(95));

  if (samplesToPrintUrls.length > 0) {
    console.log("\n[4/4] Sample Working Stream URLs for Verification:\n");
    for (const s of samplesToPrintUrls) {
      console.log(`🎬 "${s.title}" (${s.year || "?"}) - [${s.quality}p | ${s.size}]`);
      console.log(`   File:   ${s.path}`);
      console.log(`   Stream: ${s.streamUrl}`);
      console.log(`   Direct: ${s.directUrl}\n`);
    }
  }

  console.log("Verification finished!\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
