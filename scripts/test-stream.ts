#!/usr/bin/env bun
// test-stream.ts - Test ASHS sources and stream availability
// Usage (dedi):  bun scripts/test-stream.ts [tmdb_id|--all]
// Usage (local): $env:SITE_KEY="..."; $env:SITE_DOMAIN="vidzen.fun"; bun scripts/test-stream.ts [tmdb_id|--all]

import crypto from "crypto";
import fs from "fs";

const BASE = process.env.BASE_URL ?? "https://primeshow.online";

// Get credentials
let siteDomain = process.env.SITE_DOMAIN ?? "";
let siteKey    = process.env.SITE_KEY    ?? "";

if (!siteKey) {
  const DB_PATH = process.env.DB_PATH ?? "/opt/ashs/db/ashs.sqlite3";
  if (fs.existsSync(DB_PATH)) {
    const { Database } = await import("bun:sqlite");
    const db   = new Database(DB_PATH, { readonly: true });
    const site = db.prepare("SELECT * FROM approved_sites WHERE enabled=1 LIMIT 1").get() as any;
    db.close();
    if (site) { siteKey = site.api_key; siteDomain = site.domain; }
  }
}

if (!siteKey || !siteDomain) {
  console.error("Set SITE_KEY and SITE_DOMAIN env vars, or run on the dedi.");
  console.error("  PowerShell: $env:SITE_KEY=\"key\"; $env:SITE_DOMAIN=\"vidzen.fun\"; bun scripts/test-stream.ts");
  process.exit(1);
}

// HMAC signer
function sign(method: string, pathname: string): Record<string, string> {
  const ts  = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", siteKey).update(method + ":" + pathname + ":" + ts).digest("hex");
  return { "X-ASHS-Site": siteDomain, "X-ASHS-Timestamp": String(ts), "X-ASHS-Signature": sig };
}

// Test a single stream URL (HEAD request)
async function testUrl(url: string): Promise<{ ok: boolean; status: number; size: string; ranges: boolean }> {
  try {
    const r = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(8000) });
    const bytes = parseInt(r.headers.get("content-length") ?? "0", 10);
    const size  = bytes >= 1e9 ? (bytes/1e9).toFixed(2)+"GB" : bytes >= 1e6 ? (bytes/1e6).toFixed(0)+"MB" : bytes+"B";
    return { ok: r.ok || r.status === 206, status: r.status, size, ranges: r.headers.get("accept-ranges") === "bytes" };
  } catch (e) {
    return { ok: false, status: 0, size: "?", ranges: false };
  }
}

const arg = process.argv[2];

// ── SINGLE MOVIE TEST ────────────────────────────────────────────────────────
if (arg && arg !== "--all") {
  const pathname = "/v1/library/movies/" + arg;
  const res = await fetch(BASE + pathname, { headers: sign("GET", pathname) });
  if (!res.ok) { console.error("Error", res.status, await res.text()); process.exit(1); }
  const movie: any = await res.json();

  console.log("\n" + movie.title + " (" + movie.year + ") — TMDB:" + arg);
  console.log("Rating: " + movie.vote_average + "/10  |  Audio: " + (movie.stored_language ?? movie.original_language ?? "?"));
  console.log("Status: " + movie.status);

  if (!movie.sources?.length) {
    console.log("No sources yet (still downloading or failed).");
    process.exit(0);
  }

  console.log("\nSources:");
  for (const src of movie.sources) {
    const t = await testUrl(src.stream_url);
    const icon = t.ok ? "OK " : "FAIL";
    console.log("  [" + icon + "] " + src.quality + "p  " + t.size + "  HTTP:" + t.status + "  Ranges:" + (t.ranges ? "yes" : "no"));
    console.log("         " + src.stream_url);
  }
  process.exit(0);
}

// ── BATCH TEST (--all or no arg) ─────────────────────────────────────────────
const limit  = arg === "--all" ? 50 : 20;
const listPath = "/v1/library/movies?limit=" + limit;
console.log("Fetching " + limit + " movies from " + BASE + "...");

const listRes = await fetch(BASE + listPath, { headers: sign("GET", "/v1/library/movies") });
if (!listRes.ok) { console.error("List error", listRes.status, await listRes.text()); process.exit(1); }
const list: any  = await listRes.json();
const movies: any[] = list.movies ?? list.items ?? list ?? [];

if (!movies.length) { console.log("No movies in library yet."); process.exit(0); }

console.log("Testing " + movies.length + " movies...\n");

// Table header
const W = { title: 30, tmdb: 8, qual: 12, size: 8, stream: 6 };
console.log("TMDB ID  " + "Title".padEnd(W.title) + "  Qualities   Size       Stream");
console.log("-".repeat(90));

let pass = 0, fail = 0, noSrc = 0;

for (const m of movies) {
  const detailPath = "/v1/library/movies/" + m.tmdb_id;
  const dr = await fetch(BASE + detailPath, { headers: sign("GET", detailPath) });
  if (!dr.ok) { noSrc++; continue; }
  const detail: any = await dr.json();

  const title = (m.title ?? "?").slice(0, W.title).padEnd(W.title);
  const tmdb  = String(m.tmdb_id).padEnd(8);

  if (!detail.sources?.length) {
    console.log(tmdb + " " + title + "  (no sources yet)");
    noSrc++;
    continue;
  }

  // Test best source
  const best = detail.sources[0];
  const t    = await testUrl(best.stream_url);
  const quals = detail.sources.map((s: any) => s.quality + "p").join("+");
  const icon  = t.ok ? "OK " : "FAIL";

  console.log(tmdb + " " + title + "  " + quals.padEnd(12) + t.size.padEnd(10) + "[" + icon + "] HTTP:" + t.status);

  if (t.ok) pass++; else fail++;

  // Small delay to avoid hammering
  await new Promise(r => setTimeout(r, 200));
}

console.log("\n" + "=".repeat(90));
console.log("RESULTS: " + pass + " OK  |  " + fail + " FAIL  |  " + noSrc + " no-source");
console.log(pass + "/" + (pass + fail + noSrc) + " movies fully ready to stream");

if (fail > 0) {
  console.log("\nFailed streams may still be downloading. Re-run in a few minutes.");
}
