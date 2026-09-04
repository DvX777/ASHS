// src/utils/discord.ts - Discord webhook notifications (rich embeds)
import { Config } from "../config";
import { Logger } from "./logger";

const COLORS = {
  info:    0x5865f2,  // Discord blurple
  success: 0x57f287,  // Green
  warning: 0xfee75c,  // Yellow
  error:   0xed4245,  // Red
  movie:   0x2f80ed,  // Blue for movies
  tv:      0x9b59b6,  // Purple for TV
};

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w92";

interface RichEmbed {
  title:       string;
  description: string;
  color:       number;
  thumbnail?:  { url: string };
  fields?:     { name: string; value: string; inline: boolean }[];
  footer?:     { text: string; icon_url?: string };
  timestamp?:  string;
}

async function send(embeds: RichEmbed[]): Promise<void> {
  const url = Config.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body:    JSON.stringify({ embeds }),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) Logger.warn("[Discord] Webhook returned " + res.status);
  } catch (err) {
    Logger.warn("[Discord] Webhook failed: " + (err as Error).message);
  }
}

/** Generic notification */
export async function notify(
  title: string,
  description: string,
  level: "info" | "success" | "warning" | "error" = "info"
): Promise<void> {
  await send([{
    title,
    description,
    color:     COLORS[level],
    footer:    { text: "ASHS - primeshow.online" },
    timestamp: new Date().toISOString(),
  }]);
}

/** Rich download-complete notification with full media info */
export async function notifyDownloadComplete(opts: {
  title:       string;
  type:        "movie" | "tv";
  year:        number | null;
  quality:     number;
  sizeBytes:   number;
  language:    string | null;
  season?:     number;
  episode?:    number;
  posterPath?: string | null;
  genres?:     string | null;
  rating?:     number;
  overview?:   string | null;
  totalDone:   number;
  totalFiles:  number;
}): Promise<void> {
  const url = Config.DISCORD_WEBHOOK_URL;
  if (!url) return;

  const { title, type, year, quality, sizeBytes, language, season, episode,
          posterPath, genres, rating, overview, totalDone, totalFiles } = opts;

  // Format file size
  const size = sizeBytes > 1e9
    ? (sizeBytes / 1e9).toFixed(2) + " GB"
    : (sizeBytes / 1e6).toFixed(0) + " MB";

  // Type label
  const isTV    = type === "tv";
  const typeTag = isTV ? "TV Show" : "Movie";
  const epTag   = (isTV && season && episode) ? "S" + String(season).padStart(2,"0") + "E" + String(episode).padStart(2,"0") : null;

  // Quality label
  const qualityLabel = quality >= 1080 ? quality + "p (FHD)"
    : quality >= 720  ? quality + "p (HD)"
    : quality >= 480  ? quality + "p (SD)"
    : quality + "p";

  // Progress bar (done / total files in queue this session)
  const pct   = totalFiles > 0 ? Math.round((totalDone / totalFiles) * 100) : 0;
  const bar   = "[" + "#".repeat(Math.floor(pct / 10)) + "-".repeat(10 - Math.floor(pct / 10)) + "]";

  // Fields
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "Type",     value: isTV ? "TV Show" : "Movie",      inline: true },
    { name: "Quality",  value: qualityLabel,                    inline: true },
    { name: "Size",     value: size,                            inline: true },
  ];

  if (epTag) {
    fields.push({ name: "Episode", value: epTag, inline: true });
  }
  if (year) {
    fields.push({ name: "Year", value: String(year), inline: true });
  }
  if (language) {
    fields.push({ name: "Audio", value: language, inline: true });
  }
  if (genres) {
    fields.push({ name: "Genres", value: genres, inline: false });
  }
  if (rating && rating > 0) {
    const stars = Math.round(rating / 2);
    const starStr = "*".repeat(stars) + "o".repeat(5 - stars);
    fields.push({ name: "TMDB Rating", value: rating.toFixed(1) + "/10  " + starStr, inline: true });
  }

  fields.push({
    name: "Library Progress",
    value: bar + " " + pct + "% (" + totalDone + " / " + totalFiles + " files done)",
    inline: false,
  });

  const desc = overview
    ? overview.slice(0, 150) + (overview.length > 150 ? "..." : "")
    : "";

  const embed: RichEmbed = {
    title:     (isTV ? "TV  " : "Movie  ") + title + (epTag ? "  " + epTag : "") + " (" + (year ?? "?") + ")",
    description: desc,
    color:     isTV ? COLORS.tv : COLORS.movie,
    fields,
    footer:    { text: "ASHS - primeshow.online  |  " + qualityLabel + " downloaded" },
    timestamp: new Date().toISOString(),
  };

  if (posterPath) {
    embed.thumbnail = { url: TMDB_IMAGE + posterPath };
  }

  await send([embed]);
}

// Shorthand helpers
export const Discord = {
  info:    (title: string, desc: string) => notify(title, desc, "info"),
  success: (title: string, desc: string) => notify(title, desc, "success"),
  warning: (title: string, desc: string) => notify(title, desc, "warning"),
  error:   (title: string, desc: string) => notify(title, desc, "error"),
};
