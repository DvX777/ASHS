// src/download/downloader.ts — HTTP stream downloader with resume support
import fs from "fs";
import { Logger } from "../utils/logger";

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

/**
 * Download a URL to a file path with resume support.
 * Reports progress via onProgress callback.
 */
export async function downloadFile(
  url: string,
  headers: Record<string, string>,
  destPath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ size: number }> {
  // Check if partial download exists (resume)
  let startByte = 0;
  try {
    const stat = fs.statSync(destPath);
    startByte = stat.size;
    if (startByte > 0) Logger.info(`[Download] Resuming from byte ${startByte}: ${destPath}`);
  } catch {}

  const fetchHeaders: Record<string, string> = {
    ...headers,
    "user-agent": headers["user-agent"] ?? "Mozilla/5.0",
  };
  if (startByte > 0) fetchHeaders["Range"] = `bytes=${startByte}-`;

  const res = await fetch(url, {
    headers: fetchHeaders,
    signal: AbortSignal.timeout(120_000), // 2 min connect timeout
  });

  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  if (!res.body) throw new Error("Response has no body");

  const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
  const totalSize = contentLength + startByte;

  // Open file for append (resume) or write (fresh)
  const fd = fs.openSync(destPath, startByte > 0 ? "a" : "w");
  let downloaded = startByte;

  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      downloaded += value.length;
      if (onProgress && totalSize > 0) {
        onProgress({ downloaded, total: totalSize, percent: downloaded / totalSize });
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return { size: downloaded };
}
