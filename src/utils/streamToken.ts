
// src/utils/streamToken.ts - Obfuscate stream URLs with hex-encoded daily tokens
export function encodeStreamToken(type: string, tmdbId: string, quality: number, season = 0, episode = 0): string {
  const d = new Date();
  const day = d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,"0") + String(d.getUTCDate()).padStart(2,"0");
  const plain = type + ":" + tmdbId + ":" + quality + ":" + season + ":" + episode + ":" + day;
  return Buffer.from(plain).toString("hex");
}

export function decodeStreamToken(token: string): { type: string; tmdbId: string; quality: number; season: number; episode: number; valid: boolean } | null {
  try {
    const plain = Buffer.from(token, "hex").toString("utf8");
    const parts = plain.split(":");
    if (parts.length < 6) return null;
    const [type, tmdbId, qualStr, seasonStr, episodeStr, day] = parts;
    // Check day is today or yesterday (allow 48h window)
    const d = new Date();
    const today = d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,"0") + String(d.getUTCDate()).padStart(2,"0");
    d.setUTCDate(d.getUTCDate() - 1);
    const yesterday = d.getUTCFullYear() + String(d.getUTCMonth()+1).padStart(2,"0") + String(d.getUTCDate()).padStart(2,"0");
    const valid = day === today || day === yesterday;
    return { type, tmdbId, quality: parseInt(qualStr,10), season: parseInt(seasonStr,10), episode: parseInt(episodeStr,10), valid };
  } catch { return null; }
}
