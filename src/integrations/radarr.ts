// src/integrations/radarr.ts - Radarr v3 API Client
import { Config } from "../config";
import { Logger } from "../utils/logger";

export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  tmdbId: number;
  monitored: boolean;
  hasFile?: boolean;
  isAvailable?: boolean;
  folderName?: string;
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

  static async addMovie(tmdbId: number, title: string, qualityProfileId = 1): Promise<any> {
    const payload = {
      title,
      tmdbId,
      qualityProfileId,
      rootFolderPath: Config.RADARR_ROOT_FOLDER,
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
      throw new Error(`Failed to add movie to Radarr (${res.status}): ${text}`);
    }
    return await res.json();
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

  static async rescanMovie(movieId: number): Promise<boolean> {
    const res = await fetch(this.url("/command"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name: "RescanMovie", movieId }),
    });
    return res.ok;
  }
}
