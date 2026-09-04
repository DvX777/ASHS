#!/usr/bin/env bun
// test-stream.ts - Test ASHS library and get a stream source URL
// Works both locally and on the dedi.
//
// Usage:
//   On dedi (auto-reads DB):
//     bun scripts/test-stream.ts [tmdb_id]
//
//   Locally or anywhere (set env vars):
//     SITE_KEY=<your_api_key> SITE_DOMAIN=vidzen.fun bun scripts/test-stream.ts [tmdb_id]
//     SITE_KEY=abc123 BASE_URL=https://primeshow.online bun scripts/test-stream.ts 27205
//
// Env vars:
//   BASE_URL     - ASHS base URL (default: https://primeshow.online)
//   SITE_DOMAIN  - Your approved site domain
//   SITE_KEY     - Your site API key
//   DB_PATH      - SQLite path (auto-used if on dedi and file exists)

import crypto from ""crypto"";
import fs from ""fs"";

const BASE = process.env.BASE_URL ?? ""https://primeshow.online"";

// ── Get site credentials ───────────────────────────────────────────────────
let siteDomain = process.env.SITE_DOMAIN ?? """";
let siteKey    = process.env.SITE_KEY    ?? """";

// Auto-read from DB if running on dedi and no env vars set
if (!siteKey) {
  const DB_PATH = process.env.DB_PATH ?? ""/opt/ashs/db/ashs.sqlite3"";
  if (fs.existsSync(DB_PATH)) {
    const { Database } = await import(""bun:sqlite"");
    const db   = new Database(DB_PATH, { readonly: true });
    const site = db.prepare(""SELECT * FROM approved_sites WHERE enabled=1 LIMIT 1"").get() as any;
    db.close();
    if (site) { siteKey = site.api_key; siteDomain = site.domain; }
  }
}

if (!siteKey || !siteDomain) {
  console.error(""No credentials found. Set SITE_KEY and SITE_DOMAIN env vars:"");
  console.error(""  SITE_KEY=your_key SITE_DOMAIN=vidzen.fun bun scripts/test-stream.ts"");
  process.exit(1);
}

console.log(""Base URL: "", BASE);
console.log(""Site:     "", siteDomain);
console.log(""Key:      "", siteKey.slice(0, 8) + ""..."");

// ── HMAC signer ───────────────────────────────────────────────────────────
function sign(method: string, pathname: string): Record<string, string> {
  const ts  = Math.floor(Date.now() / 1000);
  const msg = method + "":"" + pathname + "":"" + ts;
  const sig = crypto.createHmac(""sha256"", siteKey).update(msg).digest(""hex"");
  return {
    ""X-ASHS-Site"":      siteDomain,
    ""X-ASHS-Timestamp"": String(ts),
    ""X-ASHS-Signature"": sig,
  };
}

// ── Pick a movie ──────────────────────────────────────────────────────────
const tmdbArg = process.argv[2];
let tmdbId: string;

if (tmdbArg) {
  tmdbId = tmdbArg;
  console.log(""\nTesting TMDB ID:"", tmdbId);
} else {
  // List movies and pick the first ready one
  console.log(""\nFetching movie list...");
  const listPath = ""/v1/library/movies?limit=5&sort=popular"";
  const listRes  = await fetch(BASE + listPath, { headers: sign(""GET"", listPath) });
  if (!listRes.ok) {
    console.error(""List error"", listRes.status, await listRes.text());
    process.exit(1);
  }
  const list: any = await listRes.json();
  const movies = list.movies ?? list.items ?? list ?? [];
  if (!movies.length) { console.error(""No movies available yet.""); process.exit(1); }

  console.log(""\nTop movies in library:"");
  movies.slice(0, 5).forEach((m: any, i: number) => {
    console.log(""  "" + (i+1) + "". "" + m.title + "" ("" + m.year + "") - TMDB:"" + m.tmdb_id);
  });

  tmdbId = String(movies[0].tmdb_id);
  console.log(""\nUsing first result - TMDB:"", tmdbId);
}

// ── Fetch movie detail + sources ──────────────────────────────────────────
const pathname = ""/v1/library/movies/"" + tmdbId;
console.log(""\nCalling:"", BASE + pathname);
const res = await fetch(BASE + pathname, { headers: sign(""GET"", pathname) });

if (res.status === 404) { console.error(""Movie not in library yet - try a different TMDB ID""); process.exit(1); }
if (!res.ok)            { console.error(""API error"", res.status, await res.text()); process.exit(1); }

const movie: any = await res.json();

console.log("""");
console.log(""════════════════════════════════════"");
console.log(""Title:   "", movie.title, ""("" + movie.year + "")"");
console.log(""Rating:  "", (movie.vote_average ?? 0) + ""/10"");
console.log(""Audio:   "", movie.stored_language ?? movie.original_language ?? ""?"");
console.log(""Status:  "", movie.status);
console.log(""════════════════════════════════════"");

// ── Print all sources ─────────────────────────────────────────────────────
if (!movie.sources?.length) {
  console.log(""\nNo stream sources available yet (still downloading)."");
  process.exit(0);
}

console.log(""\nAvailable Sources:"");
for (const src of movie.sources) {
  const size = src.size_bytes >= 1e9
    ? (src.size_bytes / 1e9).toFixed(2) + "" GB""
    : (src.size_bytes / 1e6).toFixed(0) + "" MB"";
  console.log(""  ["" + src.quality + ""p]  "" + size + ""  ("" + (src.format ?? ""mp4"") + "")"");
  console.log(""       "" + src.stream_url);
}

// ── Test best source with HEAD request ────────────────────────────────────
const best = movie.sources[0];
console.log(""\nTesting "" + best.quality + ""p stream..."");
try {
  const head = await fetch(best.stream_url, {
    method: ""HEAD"",
    headers: { Range: ""bytes=0-1023"" },
    signal: AbortSignal.timeout(10_000),
  });
  console.log(""  Status:        "", head.status, head.statusText);
  console.log(""  Content-Type:  "", head.headers.get(""content-type"") ?? ""?"");
  console.log(""  Content-Length:"", head.headers.get(""content-length"") ?? ""?"", ""bytes"");
  console.log(""  Accept-Ranges: "", head.headers.get(""accept-ranges"") ?? ""?"");

  if (head.ok || head.status === 206) {
    console.log(""\n  STREAM LIVE - byte-range enabled, ready to play"");
  } else {
    console.log(""\n  Stream not accessible (status:"", head.status + "")"");
  }
} catch (e) {
  console.error(""  HEAD request failed:"", (e as Error).message);
}

console.log(""\n--- Stream URL (use this in your player) ---"");
console.log(best.stream_url);