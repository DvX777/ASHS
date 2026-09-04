// src/config.ts — Central config loaded from environment

const env = (key: string, fallback = ""): string =>
  process.env[key] ?? fallback;

const envInt = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
};

const envFloat = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
};

export const Config = {
  // Ports
  API_PORT: envInt("API_PORT", 4000),
  FILE_PORT: envInt("FILE_PORT", 4001),

  // Storage
  DB_PATH: env("DB_PATH", "./ashs.sqlite3"),
  TEMP_DIR: env("TEMP_DIR", "./temp"),
  MEDIA_DIR: env("MEDIA_DIR", "./media"),

  // TMDB
  TMDB_API_KEY: env("TMDB_API_KEY"),
  TMDB_BASE: "https://api.themoviedb.org/3",

  // MovieBox
  MOVIEBOX_API_BASE: "https://h5-api.aoneroom.com",
  MOVIEBOX_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",

  // Security
  ADMIN_API_KEY: env("ADMIN_API_KEY"),

  // Discord
  DISCORD_WEBHOOK_URL: env("DISCORD_WEBHOOK_URL"),

  // Ingestion
  MAX_CONCURRENT_DOWNLOADS: envInt("MAX_CONCURRENT_DOWNLOADS", 3),
  DISK_CLEANUP_THRESHOLD: envFloat("DISK_CLEANUP_THRESHOLD", 0.85),

  // CORS
  CORS_ORIGINS: env("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),

  // Environment
  IS_PROD: env("NODE_ENV") === "production",
} as const;
