// src/api/routes/library.ts
import { Elysia } from "elysia";
import { db, MediaQueries, FileQueries } from "../../db";
import { checkRateLimit } from "../middleware/rateLimit";
import { siteAuth } from "../middleware/auth";

function buildStreamUrl(tmdbId: string, type: string, quality: number, season = 0, episode = 0): string {
  const token = encodeStreamToken(type, String(tmdbId), quality, season, episode);
  return "https://primeshow.online/v1/s/" + token;
}

function formatMedia(m: any, files: any[]) {
  return {
    tmdb_id: m.tmdb_id, type: m.type, title: m.title, original_title: m.original_title,
    year: m.year, poster_path: m.poster_path, backdrop_path: m.backdrop_path,
    overview: m.overview, genres: m.genres ? JSON.parse(m.genres) : [],
    popularity: m.popularity, vote_average: m.vote_average, runtime: m.runtime,
    language: m.stored_language && m.stored_language !== 'Original' ? m.stored_language : m.original_language, status: m.status,
    sources: files.filter(f => f.status === "complete" && f.file_path)
      .sort((a, b) => b.quality - a.quality)
      .map(f => ({
        quality: f.quality, format: f.format, size_bytes: f.file_size, duration: f.duration,
        stream_url: buildStreamUrl(m.tmdb_id, m.type, f.quality, f.season, f.episode),
      })),
  };
}

export const libraryRoutes = new Elysia({ prefix: "/v1/library" })
  .use(siteAuth)
  .onBeforeHandle(({ request, store, set }: any) => {
    const site = (store as any).site;
    if (site && !checkRateLimit(site.domain, site.rate_limit_rpm)) {
      set.status = 429; throw new Error("Rate limit exceeded");
    }
  })
  .get("/movies", ({ query }: any) => {
    const page = parseInt(query.page ?? "1", 10);
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 100);
    return MediaQueries.listReady.all("movie", limit, (page-1)*limit)
      .map(m => formatMedia(m, FileQueries.forMedia.all(m.id)));
  })
  .get("/movies/:tmdbId", ({ params }: any) => {
    const m = MediaQueries.findByTmdb.get(params.tmdbId, "movie");
    if (!m) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return formatMedia(m, FileQueries.forMedia.all(m.id));
  })
  .get("/tv", ({ query }: any) => {
    const page = parseInt(query.page ?? "1", 10);
    const limit = Math.min(parseInt(query.limit ?? "50", 10), 100);
    return MediaQueries.listReady.all("tv", limit, (page-1)*limit)
      .map(m => formatMedia(m, FileQueries.forMedia.all(m.id)));
  })
  .get("/tv/:tmdbId", ({ params }: any) => {
    const m = MediaQueries.findByTmdb.get(params.tmdbId, "tv");
    if (!m) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return formatMedia(m, FileQueries.forMedia.all(m.id));
  })

  .get("/tv/:tmdbId/:season", ({ params }: any) => {
    const m = MediaQueries.findByTmdb.get(params.tmdbId, "tv");
    if (!m) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    const season = parseInt(params.season, 10);
    const files  = (db.prepare(
      "SELECT * FROM media_files WHERE media_id=? AND season=? ORDER BY episode ASC, quality DESC"
    ).all(m.id, season) as any[]);
    if (!files.length) return new Response(JSON.stringify({ error: "Season not found" }), { status: 404 });

    // Group by episode
    const episodes: Record<number, any> = {};
    for (const f of files) {
      if (!episodes[f.episode]) {
        episodes[f.episode] = {
          episode: f.episode,
          season,
          status: f.status,
          sources: [],
        };
      }
      if (f.status === "complete" && f.file_path) {
        episodes[f.episode].sources.push({
          quality: f.quality,
          format:  f.format,
          size_bytes: f.file_size,
          stream_url: buildStreamUrl(m.tmdb_id, "tv", f.quality, season, f.episode),
        });
      }
    }

    return {
      tmdb_id: m.tmdb_id,
      title:   m.title,
      season,
      language: m.stored_language,
      episodes: Object.values(episodes).sort((a: any, b: any) => a.episode - b.episode),
    };
  })
  .get("/check/:tmdbId", ({ params, query }: any) => {
    const type = query.type ?? "movie";
    const m = MediaQueries.findByTmdb.get(params.tmdbId, type);
    if (!m || m.status !== "ready") return { available: false };
    const files = FileQueries.forMedia.all(m.id).filter(f => f.status === "complete");
    return {
      available: files.length > 0,
      qualities: [...new Set(files.map(f => f.quality))].sort((a,b) => b-a),
      language: m.stored_language, file_count: files.length,
      total_size: files.reduce((s, f) => s + f.file_size, 0),
    };
  })
  .get("/search", ({ query }: any) => {
    const q = `%${query.q ?? ""}%`;
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 50);
    return (db.prepare("SELECT * FROM media WHERE status='ready' AND (title LIKE ? OR original_title LIKE ?) ORDER BY popularity DESC LIMIT ?").all(q, q, limit) as any[])
      .map(m => formatMedia(m, FileQueries.forMedia.all(m.id)));
  })
  .get("/recent", ({ query }: any) => {
    const limit = Math.min(parseInt(query.limit ?? "20", 10), 50);
    return MediaQueries.recent.all(limit).map(m => formatMedia(m, FileQueries.forMedia.all(m.id)));
  })
  .get("/stats", () => {
    const g = (sql: string) => (db.prepare(sql).get() as any);
    return {
      movies:      g("SELECT COUNT(*) as c FROM media WHERE type='movie' AND status='ready'").c,
      tv_shows:    g("SELECT COUNT(*) as c FROM media WHERE type='tv' AND status='ready'").c,
      total_files: g("SELECT COUNT(*) as c FROM media_files WHERE status='complete'").c,
      total_bytes: g("SELECT COALESCE(SUM(file_size),0) as s FROM media_files WHERE status='complete'").s,
    };
  });
