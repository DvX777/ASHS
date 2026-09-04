// src/fileserver/app.ts — File server on port 4001
import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import path from "path";
import { Config } from "../config";
import { db, MediaQueries, FileQueries } from "../db";
import { streamFile } from "./stream";
import { resolveMediaPath } from "../storage/paths";
import { decodeStreamToken } from "../utils/streamToken";
import { SiteQueries } from "../db";
import { verifyHMAC } from "../utils/hmac";

function verifyRequest(request: Request): boolean {
  const domain    = request.headers.get("X-ASHS-Site") ?? "";
  const tsRaw     = request.headers.get("X-ASHS-Timestamp") ?? "0";
  const signature = request.headers.get("X-ASHS-Signature") ?? "";
  const timestamp = parseInt(tsRaw, 10);
  const site = SiteQueries.findByDomain.get(domain);
  if (!site) return false;
  const url = new URL(request.url);
  return verifyHMAC(site.api_key, request.method, url.pathname, timestamp, signature);
}

export function createFileApp() {
  return new Elysia()
    .use(cors({ origin: Config.CORS_ORIGINS.includes("*") ? true : Config.CORS_ORIGINS }))

    // Stream movie
    .get("/v1/stream/movie/:tmdbId", ({ params, query, request, set }: any) => {
      // No auth on stream endpoints — HMAC is enforced at the library API level when getting the URL
      const m = MediaQueries.findByTmdb.get(params.tmdbId, "movie");
      if (!m) { set.status = 404; return { error: "Not found" }; }
      const quality = parseInt(query.q ?? "1080", 10);
      const files   = FileQueries.forMedia.all(m.id).filter((f: any) => f.status === "complete");
      const file    = files.find((f: any) => f.quality === quality) ?? files.sort((a: any, b: any) => b.quality - a.quality)[0];
      if (!file?.file_path) { set.status = 404; return { error: "File not found" }; }
      const absPath = resolveMediaPath(file.file_path);
      return streamFile(absPath, request.headers.get("Range"));
    })

    // Stream TV episode
    .get("/v1/stream/tv/:tmdbId/:season/:episode", ({ params, query, request, set }: any) => {
      // No auth on stream endpoints — HMAC is enforced at the library API level when getting the URL
      const m = MediaQueries.findByTmdb.get(params.tmdbId, "tv");
      if (!m) { set.status = 404; return { error: "Not found" }; }
      const quality = parseInt(query.q ?? "1080", 10);
      const season  = parseInt(params.season, 10);
      const episode = parseInt(params.episode, 10);
      const files   = FileQueries.forEpisode.all(m.id, season, episode).filter((f: any) => f.status === "complete");
      const file    = files.find((f: any) => f.quality === quality) ?? files.sort((a: any, b: any) => b.quality - a.quality)[0];
      if (!file?.file_path) { set.status = 404; return { error: "File not found" }; }
      return streamFile(resolveMediaPath(file.file_path), request.headers.get("Range"));
    })

    // Obfuscated stream endpoint - /v1/s/:token where token is hex-encoded
    .get("/v1/s/:token", ({ params, request, set }: any) => {
      const tok = decodeStreamToken(params.token);
      if (!tok) { set.status = 400; return { error: "Invalid token" }; }
      if (!tok.valid) { set.status = 410; return { error: "Stream URL expired" }; }
      const m = MediaQueries.findByTmdb.get(tok.tmdbId, tok.type);
      if (!m) { set.status = 404; return { error: "Not found" }; }
      const files = tok.type === "tv"
        ? (FileQueries.forEpisode as any).all(m.id, tok.season, tok.episode).filter((f: any) => f.status === "complete")
        : (FileQueries.forMedia as any).all(m.id).filter((f: any) => f.status === "complete");
      const file = files.find((f: any) => f.quality === tok.quality) ?? files.sort((a: any, b: any) => b.quality - a.quality)[0];
      if (!file?.file_path) { set.status = 404; return { error: "File not found" }; }
      return streamFile(resolveMediaPath(file.file_path), request.headers.get("Range"));
    })
    .all("*", ({ set }: any) => { set.status = 404; return { error: "Not found" }; });
}
