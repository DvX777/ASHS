// src/ingestion/resolver.ts
// MovieBox resolver ported from the proven Vidzen moviebox.ts + vidfox providers.
// KEY FIX: search is POST with JSON body, not GET. iOS UA for search, Windows UA for play.

import { Config } from "../config";
import { Logger } from "../utils/logger";

const H5_API  = "https://h5-api.aoneroom.com";
const UA_IOS  = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15";
const UA_WIN  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TIMEOUT = 15_000;
const MATCH_THRESHOLD = 80;

// ── String helpers ─────────────────────────────────────────────────────────────
const cleanStr = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function similarity(a: string, b: string): number {
  const ca = cleanStr(a), cb = cleanStr(b);
  if (ca === cb) return 100;
  if (!ca.length || !cb.length) return 0;
  const longer  = ca.length > cb.length ? ca : cb;
  const shorter = ca.length > cb.length ? cb : ca;
  let matches = 0;
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    if (longer.slice(i, i + shorter.length) === shorter) { matches = shorter.length; break; }
  }
  // Levenshtein-light: shared character ratio
  let shared = 0;
  const bArr = cb.split("");
  for (const ch of ca) {
    const idx = bArr.indexOf(ch);
    if (idx !== -1) { shared++; bArr.splice(idx, 1); }
  }
  return Math.round((shared * 2 / (ca.length + cb.length)) * 100);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
async function postSearch(keyword: string, subjectType: number): Promise<any[]> {
  try {
    const res = await fetch(`${H5_API}/wefeed-h5api-bff/subject/search`, {
      method: "POST",
      headers: {
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "User-Agent":     UA_IOS,               // iOS UA for search (proven working)
        "Origin":         "https://h5.aoneroom.com",
        "Referer":        "https://h5.aoneroom.com/",
        "x-client-info":  '{"timezone":"Asia/Dhaka"}',
        "x-forwarded-for": "103.20.104.10",
      },
      body: JSON.stringify({ keyword, page: 1, perPage: 28, subjectType }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      Logger.warn("[Resolver] Search returned " + res.status + " for: " + keyword);
      return [];
    }
    const json = await res.json() as any;
    return (json?.code === 0 && json?.data?.items) ? json.data.items : [];
  } catch (err) {
    Logger.warn("[Resolver] Search error for " + keyword + ": " + (err as Error).message);
    return [];
  }
}

async function fetchDetail(detailPath: string): Promise<any | null> {
  try {
    const res = await fetch(`${H5_API}/wefeed-h5api-bff/detail?detailPath=${detailPath}`, {
      headers: {
        "Accept":       "application/json",
        "User-Agent":   UA_IOS,
        "Origin":       "https://h5.aoneroom.com",
        "Referer":      "https://h5.aoneroom.com/",
        "x-client-info": '{"timezone":"Asia/Dhaka"}',
        "x-forwarded-for": "103.20.104.10",
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const json = await res.json() as any;
    return (json?.code === 0 && json?.data) ? json.data : null;
  } catch {
    return null;
  }
}

async function fetchStreams(subjectId: string, detailPath: string, se = 0, ep = 0): Promise<any[]> {
  const url     = `${H5_API}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${detailPath}`;
  const referer = `${H5_API}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept":           "application/json",
        "User-Agent":       UA_WIN,             // Windows UA for play endpoint
        "Origin":           H5_API,
        "Referer":          referer,
        "x-client-info":    '{"timezone":"Asia/Dhaka"}',
        "x-forwarded-for":  "103.20.104.10",
        "cache-control":    "no-cache",
        "pragma":           "no-cache",
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return [];
    const json = await res.json() as any;
    return (json?.code === 0 && json?.data?.streams) ? json.data.streams : [];
  } catch {
    return [];
  }
}

// ── Dub selection: EN > country lang > Original ────────────────────────────────
const LANG_MAP: Record<string, string[]> = {
  hi: ["hindi"], ko: ["korean"], ja: ["japanese"], zh: ["chinese", "mandarin"],
  fr: ["french"], es: ["spanish"], pt: ["portuguese"], de: ["german"],
  ar: ["arabic"], tr: ["turkish"], ru: ["russian"], it: ["italian"],
  th: ["thai"], id: ["indonesian"], vi: ["vietnamese"],
};

function selectBestDub(dubs: any[], tmdbOriginalLang: string): any {
  if (!dubs.length) return null;
  const lower = (d: any) => (d.lanName || "").toLowerCase();
  // 1. English dub
  const eng = dubs.find(d => lower(d).includes("english") || lower(d) === "en");
  if (eng) return eng;
  // 2. TMDB original language
  const targets = LANG_MAP[tmdbOriginalLang] ?? [];
  for (const target of targets) {
    const found = dubs.find(d => lower(d).includes(target));
    if (found) return found;
  }
  // 3. MovieBox "original" flag
  const orig = dubs.find(d => d.original === true || lower(d).includes("original"));
  if (orig) return orig;
  // 4. First available
  return dubs[0];
}

// ── Best item matcher (ported from vidfox) ─────────────────────────────────────
function findBestItem(items: any[], title: string, year?: string): any {
  const tc = cleanStr(title);
  const getTitle = (i: any) => cleanStr((i.title || i.name || "").replace(/\s*\[.*?\]/g, ""));
  const getYear  = (i: any) => String(i.releaseDate || i.releaseYear || "").slice(0, 4);

  if (year) {
    const exact = items.find(i => getTitle(i) === tc && getYear(i) === year);
    if (exact) return exact;
  }
  const exactTitle = items.find(i => getTitle(i) === tc);
  if (exactTitle) return exactTitle;

  if (year) {
    const partialYear = items.find(i => {
      const t = getTitle(i);
      return (t.includes(tc) || tc.includes(t)) && getYear(i) === year;
    });
    if (partialYear) return partialYear;
  }
  const partial = items.find(i => {
    const t = getTitle(i);
    return t.includes(tc) || tc.includes(t);
  });
  return partial ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ResolvedSource {
  type: "mp4" | "hls";
  url: string;
  quality: number;
  sizeBytes: number;
  dub: string;
  headers: Record<string, string>;
}

export interface ResolveResult {
  subjectId: string;
  detailPath: string;
  dubName: string;
  language: string;
  sources: ResolvedSource[];
}

const streamHeaders = {
  "Origin":  H5_API,
  "Referer": H5_API + "/",
  "User-Agent": UA_WIN,
  "x-forwarded-for": "103.20.104.10",
};

export async function resolveMovie(
  title: string, year: string, originalLang: string
): Promise<ResolveResult | null> {
  try {
    Logger.info("[Resolver] Movie: " + title + " (" + year + ")");
    // subjectType: 1 = Movie (proven from Vidzen moviebox.ts)
    const items = await postSearch(title, 1);
    if (!items.length) { Logger.warn("[Resolver] No results for: " + title); return null; }

    // Filter to items that have resources
    const eligible = items.filter(i => i.hasResource !== false);
    const match = findBestItem(eligible, title, year);
    if (!match) { Logger.warn("[Resolver] No title match for: " + title); return null; }

    Logger.info("[Resolver] Matched: " + match.title + " (" + match.releaseDate + ")");

    // Fetch dubs via detail endpoint
    const detail = await fetchDetail(match.detailPath);
    let dubs: any[] = [];
    if (detail?.subject?.dubs) {
      dubs = detail.subject.dubs.filter((d: any) => !d.lanName?.toLowerCase().includes("sub"));
    }
    if (!dubs.length) {
      dubs = [{ subjectId: match.subjectId, detailPath: match.detailPath, lanName: "Original", original: true }];
    }

    const bestDub = selectBestDub(dubs, originalLang);
    if (!bestDub) return null;

    Logger.info("[Resolver] Dub: " + bestDub.lanName + " | " + bestDub.subjectId);

    // Fetch streams for selected dub
    const streams = await fetchStreams(bestDub.subjectId, bestDub.detailPath || match.detailPath);
    if (!streams.length) { Logger.warn("[Resolver] No streams for: " + title); return null; }

    const dubName = (bestDub.lanName || "Original").replace(/ dub| Audio/gi, "").trim();

    // Map to ResolvedSource, top 2 qualities only
    const sources: ResolvedSource[] = streams
      .filter((s: any) => s.url)
      .map((s: any) => ({
        type:      s.format === "MP4" ? "mp4" : "hls",
        url:       s.url,
        quality:   parseInt(s.resolutions) || 0,
        sizeBytes: parseInt(s.size) || 0,
        dub:       dubName,
        headers:   streamHeaders,
      }))
      .sort((a, b) => b.quality - a.quality)
      .slice(0, 2);

    if (!sources.length) return null;

    return {
      subjectId:  bestDub.subjectId,
      detailPath: bestDub.detailPath || match.detailPath,
      dubName,
      language:   dubName,
      sources,
    };
  } catch (err) {
    Logger.error("[Resolver] Movie \"" + title + "\" crashed: " + (err as Error).message);
    return null;
  }
}

export async function resolveTV(
  title: string, year: string, originalLang: string, season: number, episode: number
): Promise<ResolvedSource[] | null> {
  try {
    Logger.info("[Resolver] TV: " + title + " S" + season + "E" + episode);
    // subjectType: 2 = TV (proven from Vidzen moviebox.ts)
    const items = await postSearch(title, 2);
    if (!items.length) return null;

    const eligible = items.filter((i: any) => i.hasResource !== false);
    const match = findBestItem(eligible, title, year);
    if (!match) return null;

    const detail = await fetchDetail(match.detailPath);
    let dubs: any[] = [];
    if (detail?.subject?.dubs) {
      dubs = detail.subject.dubs.filter((d: any) => !d.lanName?.toLowerCase().includes("sub"));
    }
    if (!dubs.length) {
      dubs = [{ subjectId: match.subjectId, detailPath: match.detailPath, lanName: "Original", original: true }];
    }

    const bestDub = selectBestDub(dubs, originalLang);
    if (!bestDub) return null;

    const streams = await fetchStreams(bestDub.subjectId, bestDub.detailPath || match.detailPath, season, episode);
    if (!streams.length) return null;

    const dubName = (bestDub.lanName || "Original").replace(/ dub| Audio/gi, "").trim();

    return streams
      .filter((s: any) => s.url)
      .map((s: any) => ({
        type:      s.format === "MP4" ? "mp4" : "hls",
        url:       s.url,
        quality:   parseInt(s.resolutions) || 0,
        sizeBytes: parseInt(s.size) || 0,
        dub:       dubName,
        headers:   streamHeaders,
      }))
      .sort((a, b) => b.quality - a.quality)
      .slice(0, 2);
  } catch (err) {
    Logger.error("[Resolver] TV \"" + title + "\" crashed: " + (err as Error).message);
    return null;
  }
}