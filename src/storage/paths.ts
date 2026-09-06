// src/storage/paths.ts — Build structured file paths for media on disk

import path from "path";
import { Config } from "../config";

/**
 * Build the relative path for a media file.
 * Stored relative to MEDIA_DIR so DB isn't tied to absolute paths.
 *
 * Movies:   movie/533535/1080p.mp4
 * TV:       tv/94997/S01/E01/1080p.mp4
 */
export function buildRelativePath(
  type: "movie" | "tv",
  tmdbId: string,
  quality: number,
  season = 0,
  episode = 0
): string {
  if (type === "movie") {
    return path.join("movie", tmdbId, `${quality}p.mp4`);
  }
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  return path.join("tv", tmdbId, `S${s}`, `E${e}`, `${quality}p.mp4`);
}

/**
 * Build the full absolute path for a media file.
 */
export function buildAbsolutePath(
  type: "movie" | "tv",
  tmdbId: string,
  quality: number,
  season = 0,
  episode = 0
): string {
  return path.join(Config.MEDIA_DIR, buildRelativePath(type, tmdbId, quality, season, episode));
}

/**
 * Build the absolute path for a temp (in-progress) download.
 */
export function buildTempPath(jobId: number): string {
  return path.join(Config.TEMP_DIR, `dl_${jobId}.mp4.part`);
}

/**
 * Resolve a relative path stored in DB to an absolute path.
 */
export function resolveMediaPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.join(Config.MEDIA_DIR, relativePath);
}
