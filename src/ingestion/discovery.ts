// src/ingestion/discovery.ts — TMDB discovery: trending, popular, top-rated
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { db, MediaQueries } from "../db";
import { isEligible, isAlreadyReady, TmdbItem } from "./filter";

const TMDB  = Config.TMDB_BASE;
const KEY   = Config.TMDB_API_KEY;

async function tmdbGet(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${TMDB}${path}${sep}api_key=${KEY}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`);
  return res.json();
}

async function fetchPage(endpoint: string, page = 1): Promise<TmdbItem[]> {
  const json = await tmdbGet(`${endpoint}?page=${page}`);
  return json.results ?? [];
}

async function fetchPages(endpoint: string, pages: number): Promise<TmdbItem[]> {
  const results: TmdbItem[] = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const items = await fetchPage(endpoint, p);
      results.push(...items);
    } catch (err) {
      Logger.warn(`[Discovery] Page ${p} of ${endpoint} failed: ${(err as Error).message}`);
    }
  }
  return results;
}

function upsertMedia(item: TmdbItem, type: "movie" | "tv"): number | null {
  const tmdbId    = String(item.id);
  const title     = item.title ?? item.name ?? "";
  const origTitle = item.original_title ?? item.original_name ?? null;
  const year      = parseInt((item.release_date ?? item.first_air_date ?? "").slice(0, 4)) || null;
  const row = db.prepare(`
    INSERT INTO media (tmdb_id, type, title, original_title, year, popularity, vote_average, vote_count, original_language, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(tmdb_id, type) DO UPDATE SET
      popularity = excluded.popularity, vote_average = excluded.vote_average,
      vote_count = excluded.vote_count, updated_at = datetime('now')
    RETURNING id
  `).get(tmdbId, type, title, origTitle, year, item.popularity, item.vote_average, item.vote_count, item.original_language) as any;
  return row?.id ?? null;
}

export async function discoverContent(): Promise<{ added: number; skipped: number }> {
  Logger.info("[Discovery] Starting content discovery...");
  let added = 0, skipped = 0;

  const sources: Array<{ endpoint: string; type: "movie" | "tv"; pages: number }> = [
    { endpoint: "/trending/movie/day",  type: "movie", pages: 3  },
    { endpoint: "/trending/tv/day",     type: "tv",    pages: 3  },
    { endpoint: "/trending/movie/week", type: "movie", pages: 5  },
    { endpoint: "/trending/tv/week",    type: "tv",    pages: 5  },
    { endpoint: "/movie/now_playing",   type: "movie", pages: 3  },
    { endpoint: "/movie/popular",       type: "movie", pages: 10 },
    { endpoint: "/tv/popular",          type: "tv",    pages: 10 },
    { endpoint: "/movie/top_rated",     type: "movie", pages: 20 }, // classics
    { endpoint: "/tv/top_rated",        type: "tv",    pages: 20 }, // classics
  ];

  const seen = new Set<string>();

  for (const src of sources) {
    let items: TmdbItem[] = [];
    try {
      items = await fetchPages(src.endpoint, src.pages);
    } catch (err) {
      Logger.warn(`[Discovery] ${src.endpoint} failed: ${(err as Error).message}`);
      continue;
    }

    for (const item of items) {
      const key = `${src.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!isEligible(item, src.type)) { skipped++; continue; }
      if (isAlreadyReady(String(item.id), src.type)) { skipped++; continue; }

      upsertMedia(item, src.type);
      added++;
    }
  }

  Logger.info(`[Discovery] Done. Added: ${added}, Skipped: ${skipped}`);
  return { added, skipped };
}
