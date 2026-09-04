// src/api/middleware/auth.ts
import { Elysia } from "elysia";
import { SiteQueries } from "../../db";
import { verifyHMAC } from "../../utils/hmac";
import { Config } from "../../config";

export const adminAuth = new Elysia({ name: "admin-auth" }).derive(
  { as: "scoped" },
  ({ request, set }: any) => {
    const key = request.headers.get("X-ASHS-Admin-Key");
    if (!key || key !== Config.ADMIN_API_KEY) {
      set.status = 403;
      throw new Error("Forbidden: invalid admin key");
    }
    return {};
  }
);

export const siteAuth = new Elysia({ name: "site-auth" }).derive(
  { as: "scoped" },
  ({ request, set }: any) => {
    const domain    = request.headers.get("X-ASHS-Site") ?? "";
    const tsRaw     = request.headers.get("X-ASHS-Timestamp") ?? "0";
    const signature = request.headers.get("X-ASHS-Signature") ?? "";
    const timestamp = parseInt(tsRaw, 10);
    const site = SiteQueries.findByDomain.get(domain);
    if (!site) { set.status = 403; throw new Error("Forbidden: unknown site"); }
    const url   = new URL(request.url);
    const valid = verifyHMAC(site.api_key, request.method, url.pathname, timestamp, signature);
    if (!valid) { set.status = 403; throw new Error("Forbidden: invalid signature"); }
    return { site };
  }
);
