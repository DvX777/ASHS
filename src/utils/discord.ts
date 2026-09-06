// src/utils/discord.ts
import { Config } from "../config";
import { Logger } from "./logger";

const TMDB_IMG = "https://image.tmdb.org/t/p/w92";
const FOOTER   = "ASHS - primeshow.online";

const COLORS = {
  movie: 0x2f80ed, tv: 0x9b59b6, success: 0x57f287,
  warning: 0xfee75c, error: 0xed4245, info: 0x5865f2,
  season: 0x1abc9c, milestone: 0xf1c40f,
};

const LANG_MAP: Record<string,string> = {
  en:"English", fr:"French", es:"Spanish", de:"German", it:"Italian",
  pt:"Portuguese", ja:"Japanese", ko:"Korean", zh:"Chinese", hi:"Hindi",
  ar:"Arabic", ru:"Russian", tr:"Turkish", pl:"Polish", nl:"Dutch",
  sv:"Swedish", th:"Thai", id:"Indonesian", vi:"Vietnamese", fa:"Persian",
};

let lastMovieAlert = 0;
let lastMilestone  = 0;
const MOVIE_COOLDOWN = 45_000;
const MILESTONE_COOLDOWN = 300_000;

async function send(payload: object): Promise<void> {
  const url = Config.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) Logger.warn("[Discord] HTTP " + res.status);
  } catch (e) { Logger.warn("[Discord] " + (e as Error).message); }
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(0) + " MB";
  return (b / 1e3).toFixed(0) + " KB";
}
function fmtQuality(q: number): string {
  return q >= 1080 ? q+"p FHD" : q >= 720 ? q+"p HD" : q >= 480 ? q+"p SD" : q+"p";
}
function fmtLang(code: string | null): string {
  if (!code) return "Unknown";
  return LANG_MAP[code.toLowerCase()] ?? code.toUpperCase();
}
function fmtStars(r: number): string {
  if (!r || r <= 0) return "N/A";
  const s = Math.min(5, Math.round(r / 2));
  return r.toFixed(1) + "/10  " + "\u2605".repeat(s) + "\u2606".repeat(5 - s);
}
function fmtProgress(done: number, total: number): string {
  if (total <= 0) return "";
  const pct = Math.min(100, Math.round((done / total) * 100));
  const f = Math.floor(pct / 10);
  return "\u2588".repeat(f) + "\u2591".repeat(10 - f) + "  " + pct + "%  (" + done.toLocaleString() + " / " + total.toLocaleString() + " files)";
}
function thumb(p: string | null | undefined) {
  return p ? { url: TMDB_IMG + p } : undefined;
}
function fmtGenres(g: string | null | undefined): string {
  if (!g) return "";
  try { return JSON.parse(g).join(", "); } catch { return g; }
}

// 1. Generic system alert
export async function notify(title: string, description: string, level: "info"|"success"|"warning"|"error" = "info"): Promise<void> {
  const icons: Record<string,string> = { info:"[i]", success:"[OK]", warning:"[!]", error:"[X]" };
  await send({ embeds: [{ title: icons[level] + " " + title, description, color: COLORS[level], footer: { text: FOOTER }, timestamp: new Date().toISOString() }] });
}

// 2. Movie download complete (rate-limited, max 1 per 45s)
export async function notifyMovieDone(opts: {
  title: string; year: number|null; quality: number; sizeBytes: number;
  language: string|null; posterPath: string|null|undefined; genres: string|null|undefined;
  rating: number; overview: string|null|undefined; queueDone: number; queueTotal: number;
}): Promise<void> {
  if (Date.now() - lastMovieAlert < MOVIE_COOLDOWN) return;
  lastMovieAlert = Date.now();
  const { title, year, quality, sizeBytes, language, posterPath, genres, rating, overview, queueDone, queueTotal } = opts;
  const fields: any[] = [
    { name: "Quality",  value: fmtQuality(quality),      inline: true },
    { name: "Size",     value: fmtBytes(sizeBytes),       inline: true },
    { name: "Year",     value: year ? String(year) : "?", inline: true },
    { name: "Audio",    value: fmtLang(language),         inline: true },
    { name: "Rating",   value: fmtStars(rating),          inline: true },
  ];
  const g = fmtGenres(genres);
  if (g) fields.push({ name: "Genres", value: g, inline: false });
  fields.push({ name: "Queue", value: fmtProgress(queueDone, queueTotal), inline: false });
  const desc = overview ? overview.slice(0, 180) + (overview.length > 180 ? "..." : "") : "";
  await send({ embeds: [{ title: "Movie: " + title + (year ? " (" + year + ")" : ""), description: desc, color: COLORS.movie, thumbnail: thumb(posterPath), fields, footer: { text: FOOTER + " | " + fmtQuality(quality) + " ready" }, timestamp: new Date().toISOString() }] });
}

// 3. TV Season complete
export async function notifySeasonDone(opts: {
  title: string; year: number|null; season: number; episodeCount: number;
  sizeBytes: number; posterPath: string|null|undefined; rating: number; language: string|null;
}): Promise<void> {
  const { title, year, season, episodeCount, sizeBytes, posterPath, rating, language } = opts;
  await send({ embeds: [{ title: "Season Complete: " + title + " S" + String(season).padStart(2,"0") + (year ? " (" + year + ")" : ""), description: episodeCount + " episodes ready to stream", color: COLORS.season, thumbnail: thumb(posterPath), fields: [
    { name: "Season",     value: "Season " + season,    inline: true },
    { name: "Episodes",   value: String(episodeCount),  inline: true },
    { name: "Total Size", value: fmtBytes(sizeBytes),   inline: true },
    { name: "Audio",      value: fmtLang(language),     inline: true },
    { name: "Rating",     value: fmtStars(rating),      inline: true },
  ], footer: { text: FOOTER + " | All episodes ready" }, timestamp: new Date().toISOString() }] });
}

// 4. Queue milestone (25/50/75/100%)
export async function notifyMilestone(done: number, total: number): Promise<void> {
  if (total <= 0) return;
  if (Date.now() - lastMilestone < MILESTONE_COOLDOWN) return;
  const pct = Math.round((done / total) * 100);
  const isEmpty = done >= total;
  if (!isEmpty && pct !== 25 && pct !== 50 && pct !== 75) return;
  lastMilestone = Date.now();
  await send({ embeds: [{ title: isEmpty ? "Queue Complete!" : "Queue: " + pct + "% done", description: fmtProgress(done, total), color: isEmpty ? COLORS.success : COLORS.milestone, footer: { text: FOOTER }, timestamp: new Date().toISOString() }] });
}

// 5. SRR report
export async function notifySRR(healed: number, issues: string[], unavailable: number): Promise<void> {
  if (healed === 0) return;
  const parts = issues.slice(0, 8);
  if (issues.length > 8) parts.push("...and " + (issues.length - 8) + " more");
  parts.push("");
  parts.push("Unavailable on MovieBox: " + unavailable);
  const desc = parts.join("\n");
  await send({ embeds: [{ title: "SRR: " + healed + " issue(s) healed", description: desc, color: COLORS.warning, footer: { text: FOOTER }, timestamp: new Date().toISOString() }] });
}

// 6. Daily stats
export async function notifyDailyStats(opts: {
  movies:number; tvShows:number; files:number; bytes:number;
  queued:number; active:number; done:number; failed:number;
  hddUsed:number; hddTotal:number;
}): Promise<void> {
  const { movies, tvShows, files, bytes, queued, active, done, failed, hddUsed, hddTotal } = opts;
  const hddPct = hddTotal > 0 ? ((hddUsed/hddTotal)*100).toFixed(1) : "0";
  await send({ embeds: [{ title: "Daily Library Report", color: COLORS.info, fields: [
    { name: "Movies",   value: movies.toLocaleString(),  inline: true },
    { name: "TV Shows", value: tvShows.toLocaleString(), inline: true },
    { name: "Files",    value: files.toLocaleString() + " (" + fmtBytes(bytes) + ")", inline: false },
    { name: "Queue",    value: "Pending: " + queued + " | Active: " + active + " | Done: " + done + " | Failed: " + failed, inline: false },
    { name: "HDD",      value: fmtBytes(hddUsed) + " / " + fmtBytes(hddTotal) + " (" + hddPct + "% used)", inline: false },
  ], footer: { text: FOOTER }, timestamp: new Date().toISOString() }] });
}

export const Discord = {
  info:    (t: string, d: string) => notify(t, d, "info"),
  success: (t: string, d: string) => notify(t, d, "success"),
  warning: (t: string, d: string) => notify(t, d, "warning"),
  error:   (t: string, d: string) => notify(t, d, "error"),
  downloadDone: async (title: string, sizeBytes: number, quality = 1080) => {
    try {
      await send({
        embeds: [{
          title: `🎬 Movie Ready: ${title}`,
          description: `Successfully downloaded and imported into ASHS Library.\n**Quality:** ${fmtQuality(quality)}\n**Size:** ${fmtBytes(sizeBytes)}`,
          color: COLORS.movie,
          footer: { text: FOOTER + " | Stream Ready" },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (e: any) {
      Logger.warn(`[Discord] Error sending downloadDone: ${e.message}`);
    }
  },
  movieGrabbed: async (title: string, indexer = "Indexer", releaseTitle = "") => {
    try {
      await send({
        embeds: [{
          title: `📥 Movie Grabbed: ${title}`,
          description: `Radarr grabbed a torrent and sent it to qBittorrent.\n**Indexer:** ${indexer}${releaseTitle ? `\n**Release:** \`${releaseTitle}\`` : ""}`,
          color: COLORS.info,
          footer: { text: FOOTER + " | qBittorrent Downloading" },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (e: any) {
      Logger.warn(`[Discord] Error sending movieGrabbed: ${e.message}`);
    }
  },
};
