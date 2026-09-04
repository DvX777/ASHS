// src/utils/logger.ts — Structured logger with timestamps and levels

type LogLevel = "info" | "warn" | "error" | "debug";

function format(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  return `[${ts}] ${tag} ${msg}`;
}

export const Logger = {
  info: (msg: string) => console.log(format("info", msg)),
  warn: (msg: string) => console.warn(format("warn", msg)),
  error: (msg: string) => console.error(format("error", msg)),
  debug: (msg: string) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug(format("debug", msg));
    }
  },
};
