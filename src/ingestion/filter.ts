// src/ingestion/filter.ts — Content eligibility filter
import { MediaQueries } from "../db";

export interface TmdbItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity: number;
  vote_average: number;
  vote_count: number;
  original_language: string;
  media_type?: string;
  genre_ids?: number[];
}

const ANIME_LANGUAGE  = "ja";
const ANIME_GENRE_IDS = [16]; // Animation genre on TMDB

export function isEligible(item: TmdbItem, type: "movie" | "tv"): boolean {
  // Skip anime (Japanese + animation genre)
  if (item.original_language === ANIME_LANGUAGE && (item.genre_ids ?? []).some(g => ANIME_GENRE_IDS.includes(g))) return false;
  // Require minimum engagement
  if (item.vote_count < 50) return false;
  // Movies: popularity > 15 OR (classic: vote_avg > 7 AND vote_count > 500)
  if (type === "movie") {
    const isPopular = item.popularity > 15;
    const isClassic = item.vote_average >= 7.0 && item.vote_count >= 500;
    if (!isPopular && !isClassic) return false;
  }
  // TV: popularity > 25
  if (type === "tv" && item.popularity < 25) return false;
  return true;
}

export function isAlreadyReady(tmdbId: string, type: "movie" | "tv"): boolean {
  const m = MediaQueries.findByTmdb.get(tmdbId, type);
  return m?.status === "ready";
}
