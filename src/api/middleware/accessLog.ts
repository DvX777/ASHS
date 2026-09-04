// src/api/middleware/accessLog.ts — Write request logs to access_logs table
import { db } from "../../db";

const insertLog = db.prepare(
  "INSERT INTO access_logs (site_id, method, path, status_code, response_ms, bytes_sent) VALUES (?, ?, ?, ?, ?, ?)"
);

// Track request start times
const starts = new WeakMap<Request, number>();

export function markStart(request: Request): void {
  starts.set(request, Date.now());
}

export function logAccess(request: Request, set: any): void {
  try {
    const ms     = Date.now() - (starts.get(request) ?? Date.now());
    const url    = new URL(request.url);
    const status = set?.status ?? 200;
    // Skip health checks to avoid log spam
    if (url.pathname === "/health") return;
    insertLog.run(null, request.method, url.pathname, status, ms, 0);
  } catch {
    // Never let logging crash the response
  }
}
