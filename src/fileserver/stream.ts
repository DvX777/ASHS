// src/fileserver/stream.ts - Byte-range aware file streaming
import fs from "fs";
import path from "path";
import { Config } from "../config";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
  if (ext === ".ts")   return "video/MP2T";
  if (ext === ".mkv")  return "video/x-matroska";
  if (ext === ".webm") return "video/webm";
  if (ext === ".avi")  return "video/x-msvideo";
  if (ext === ".mov")  return "video/quicktime";
  return "video/mp4";
}

export function streamFile(absPath: string, rangeHeader: string | null): Response {
  if (!fs.existsSync(absPath)) {
    return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  const stat      = fs.statSync(absPath);
  const totalSize = stat.size;
  const mime      = getMimeType(absPath);

  if (!rangeHeader) {
    // Full file
    return new Response(fs.createReadStream(absPath) as any, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(totalSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        "X-Total-Size": String(totalSize),
      },
    });
  }

  // Parse Range: bytes=start-end
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return new Response("Invalid Range", { status: 416 });

  const start = parseInt(match[1] || "0", 10);
  const end   = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (start > end || end >= totalSize) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }

  const chunkSize = end - start + 1;
  const stream    = fs.createReadStream(absPath, { start, end });

  return new Response(stream as any, {
    status: 206,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
      "X-Total-Size": String(totalSize),
    },
  });
}
