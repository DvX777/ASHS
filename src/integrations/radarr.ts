// src/integrations/radarr.ts - Radarr v3 API Client
import { Config } from "../config";
import { Logger } from "../utils/logger";
import { db, MediaQueries } from "../db";
import { sleep } from "../utils/helpers";

export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  tmdbId: number;
  monitored: boolean;
  hasFile?: boolean;
  isAvailable?: boolean;
  folderName?: string;
  sizeOnDisk?: number;
  movieFile?: {
    id: number;
    relativePath: string;
    path: string;
    size: number;
    quality: { quality: { name: string; resolution: number } };
  };
}

export interface RadarrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  seeders?: number;
  leechers?: number;
  quality: { quality: { name: string; resolution: number } };
  rejections?: string[];
}

export class RadarrClient {
  private static get headers() {
    return {
      "X-Api-Key": Config.RADARR_API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  private static url(endpoint: string): string {
    return `${Config.RADARR_URL.replace(/\/+$/, "")}/api/v3${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  }

  static async getStatus(): Promise<any> {
    try {
      const res = await fetch(this.url("/system/status"), { headers: this.headers, signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { online: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { online: true, version: data.version, appName: data.appName, isLinux: data.isLinux };
    } catch (e: any) {
      return { online: false, error: e.message };
    }
  }

  static async getQueue(): Promise<any[]> {
    try {
      const res = await fetch(this.url("/queue?includeUnknownMovieItems=true&includeMovie=true"), { headers: this.headers });
      if (!res.ok) return [];
      const data = await res.json();
      return data.records ?? [];
    } catch {
      return [];
    }
  }

  static async getMovies(): Promise<RadarrMovie[]> {
    try {
      const res = await fetch(this.url("/movie"), { headers: this.headers });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  static async getDownloadedMovies(): Promise<RadarrMovie[]> {
    try {
      const movies = await this.getMovies();
      return movies.filter((m: any) => m.hasFile && (m.movieFile || (m.sizeOnDisk && m.sizeOnDisk > 0)));
    } catch (err: any) {
      Logger.error(`[Radarr] Failed to get downloaded movies: ${err.message}`);
      return [];
    }
  }

  static async addMovie(tmdbId: number, title: string, qualityProfileId = 1): Promise<any> {
    try {
      // 1. Fetch complete metadata schema from Radarr lookup (titleSlug, images, year, etc.)
      let movieData: any = null;
      try {
        const lookup = await this.lookupMovie(`tmdb:${tmdbId}`);
        if (lookup && lookup.length > 0) {
          movieData = lookup[0];
        }
      } catch (err: any) {
        Logger.warn(`[Radarr] Lookup warning for tmdb:${tmdbId}: ${err.message}`);
      }

      const payload = {
        ...(movieData || {}),
        title: movieData?.title || title,
        tmdbId,
        qualityProfileId: qualityProfileId || 1,
        rootFolderPath: Config.RADARR_ROOT_FOLDER || "/mnt/media/movies",
        monitored: true,
        addOptions: {
          searchForMovie: true,
        },
      };

      const res = await fetch(this.url("/movie"), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 400 && text.toLowerCase().includes("already been added")) {
          // Movie already in Radarr. Trigger search if it has no file yet.
          try {
            const movies = await this.getMovies();
            const existing = movies.find((m: any) => m.tmdbId === tmdbId);
            if (existing && !existing.hasFile && existing.id) {
              await this.autoSearch(existing.id).catch(() => {});
              return { ...existing, alreadyAdded: true };
            }
          } catch {}
          return { alreadyAdded: true, title, tmdbId };
        }
        throw new Error(`Failed to add movie to Radarr (${res.status}): ${text}`);
      }

      const created = await res.json();
      Logger.info(`[Radarr] Successfully added movie: "${title}" (TMDB: ${tmdbId})`);
      return created;
    } catch (e: any) {
      Logger.error(`[Radarr] Add movie error for "${title}": ${e.message}`);
      throw e;
    }
  }

  static async syncMoviesWithASHS(): Promise<{ synced: number }> {
    try {
      const downloaded = await this.getDownloadedMovies();
      let synced = 0;
      for (const m of downloaded) {
        if (!m.tmdbId) continue;
        const tmdbId = String(m.tmdbId);
        const title = m.title;
        const year = m.year ?? null;
        const absPath = m.movieFile?.path || m.movieFile?.relativePath || "";
        const size = m.movieFile?.size || m.sizeOnDisk || 0;
        const qualityName = m.movieFile?.quality?.quality?.name ?? "1080p";
        let res = 1080;
        if (/2160|4k/i.test(qualityName)) res = 2160;
        else if (/720/i.test(qualityName)) res = 720;
        else if (/480/i.test(qualityName)) res = 480;

        db.prepare(`
          INSERT INTO media (tmdb_id, type, title, year, status)
          VALUES (?, 'movie', ?, ?, 'ready')
          ON CONFLICT(tmdb_id, type) DO UPDATE SET
            status = 'ready',
            updated_at = datetime('now')
        `).run(tmdbId, title, year);

        const mediaRow = MediaQueries.findByTmdb.get(tmdbId, "movie");
        if (mediaRow && absPath) {
          db.prepare(`
            INSERT INTO media_files (media_id, season, episode, quality, language, format, file_path, file_size, status, completed_at, progress)
            VALUES (?, 0, 0, ?, 'Original', 'mkv', ?, ?, 'complete', datetime('now'), 1.0)
            ON CONFLICT(media_id, season, episode, quality) DO UPDATE SET
              file_path = excluded.file_path,
              file_size = excluded.file_size,
              status = 'complete',
              completed_at = datetime('now'),
              progress = 1.0
          `).run(mediaRow.id, res, absPath, size);
          synced++;
        }
      }
      if (synced > 0) {
        Logger.info(`[RadarrSync] Reconciled ${synced} downloaded movies from Radarr into ASHS database`);
      }
      return { synced };
    } catch (e: any) {
      Logger.error(`[RadarrSync] Sync error: ${e.message}`);
      return { synced: 0 };
    }
  }

  static async importExistingAshsMoviesToRadarr(): Promise<{ queued: number; total: number }> {
    try {
      const readyMovies = db.prepare(`
        SELECT m.id, m.tmdb_id, m.title, m.year
        FROM media m
        WHERE m.type = 'movie' AND m.status = 'ready'
      `).all() as any[];

      const radarrMovies = await this.getMovies();
      const existingTmdb = new Set(radarrMovies.map((r: any) => String(r.tmdbId)));

      let queued = 0;
      for (const m of readyMovies) {
        if (existingTmdb.has(String(m.tmdb_id))) continue;
        try {
          const lookup = await this.lookupMovie(`tmdb:${m.tmdb_id}`);
          const movieData = lookup?.[0];
          const payload = {
            ...(movieData || {}),
            title: movieData?.title || m.title,
            tmdbId: parseInt(m.tmdb_id, 10),
            qualityProfileId: 1,
            rootFolderPath: Config.RADARR_ROOT_FOLDER || "/mnt/media/movies",
            monitored: true,
            addOptions: {
              searchForMovie: false, // Already exists on disk
            },
          };
          const res = await fetch(this.url("/movie"), {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(payload),
          });
          if (res.ok) {
            queued++;
            existingTmdb.add(String(m.tmdb_id));
          }
          await sleep(200);
        } catch (err: any) {
          Logger.warn(`[RadarrImport] Could not add ${m.title}: ${err.message}`);
        }
      }

      // Tell Radarr to rescan root folders for matched files
      await fetch(this.url("/command"), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ name: "RescanFolders" }),
      }).catch(() => {});

      Logger.info(`[RadarrImport] Registered ${queued} ASHS movies into Radarr (Total: ${readyMovies.length})`);
      return { queued, total: readyMovies.length };
    } catch (e: any) {
      Logger.error(`[RadarrImport] Import error: ${e.message}`);
      throw e;
    }
  }

  static async manualSearch(movieId: number): Promise<RadarrRelease[]> {
    const res = await fetch(this.url(`/release?movieId=${movieId}`), { headers: this.headers });
    if (!res.ok) return [];
    return await res.json();
  }

  static async grabRelease(guid: string, indexerId: number): Promise<boolean> {
    const res = await fetch(this.url("/release"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ guid, indexerId }),
    });
    return res.ok;
  }

  static async getQualityProfiles(): Promise<any[]> {
    try {
      const res = await fetch(this.url("/qualityprofile"), { headers: this.headers });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  static async deleteQueueItem(id: number, removeFromClient = true, blocklist = false): Promise<boolean> {
    const res = await fetch(this.url(`/queue/${id}?removeFromClient=${removeFromClient}&blocklist=${blocklist}`), {
      method: "DELETE",
      headers: this.headers,
    });
    return res.ok;
  }

  static async autoSearch(movieId: number): Promise<boolean> {
    const res = await fetch(this.url("/command"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name: "MoviesSearch", movieIds: [movieId] }),
    });
    return res.ok;
  }

  static async lookupMovie(term: string): Promise<any[]> {
    const res = await fetch(this.url(`/movie/lookup?term=${encodeURIComponent(term)}`), {
      headers: this.headers,
    });
    if (!res.ok) return [];
    return await res.json();
  }

  static async rescanMovie(movieId: number): Promise<boolean> {
    const res = await fetch(this.url("/command"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name: "RescanMovie", movieId }),
    });
    return res.ok;
  }
}
