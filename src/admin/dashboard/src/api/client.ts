// src/api/client.ts
const BASE = "";

// Simple event so auth store can react to 401s without page reloads
type AuthListener = () => void;
const _authListeners: AuthListener[] = [];
export function onUnauthorized(fn: AuthListener) { _authListeners.push(fn); }
function notifyUnauthorized() { _authListeners.forEach(fn => fn()); }

async function req<T>(
  method: string,
  path: string,
  body?: any,
  opts?: { silent401?: boolean }
): Promise<T> {
  const res = await fetch(`${BASE}/0x/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Never do a hard redirect — let the auth store handle it
    if (!opts?.silent401) notifyUnauthorized();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  get:    <T>(path: string) => req<T>("GET",    path),
  post:   <T>(path: string, body?: any) => req<T>("POST",   path, body),
  patch:  <T>(path: string, body?: any) => req<T>("PATCH",  path, body),
  delete: <T>(path: string) => req<T>("DELETE", path),

  // Auth — silent401 so a failed check never fires notifyUnauthorized (just return false)
  login:     (key: string) => req<{ ok: boolean }>("POST", "/auth/login",  { key }),
  logout:    () =>            req<{ ok: boolean }>("POST", "/auth/logout"),
  checkAuth: () =>            req<{ ok: boolean }>("GET",  "/auth/check", undefined, { silent401: true }),

  // Radarr & qBittorrent
  radarrStatus:   () => req<any>("GET", "/radarr/status"),
  radarrQueue:    () => req<any>("GET", "/radarr/queue"),
  radarrSearch:   (movieId: number) => req<any>("GET", `/radarr/search?movieId=${movieId}`),
  radarrGrab:     (guid: string, indexerId: number) => req<any>("POST", "/radarr/grab", { guid, indexerId }),
  radarrProfiles: () => req<any>("GET", "/radarr/profiles"),

  // System
  health:       () => req<any>("GET",  "/system/stats"),
  logs:         (type: "out" | "error", lines = 100) => req<{ lines: string[] }>("GET", `/system/logs?type=${type}&lines=${lines}`),
  triggerSRR:   () => req<any>("POST", "/srr/run"),
  triggerIngest:() => req<any>("POST", "/system/ingest"),
  triggerMeta:  () => req<any>("POST", "/system/refresh-meta"),
  cleanTemp:    () => req<any>("POST", "/system/cleanup-temp"),

  // Media
  media:           (params?: Record<string, string>) => req<any>("GET", "/media?" + new URLSearchParams(params)),
  mediaDetail:     (id: number) => req<any>("GET",   `/media/${id}`),
  patchMediaStatus:(id: number, status: string) => req<any>("PATCH", `/media/${id}/status`, { status }),
  retryMedia:      (id: number) => req<any>("POST",  `/media/${id}/retry`),
  deleteMedia:     (id: number) => req<any>("DELETE",`/media/${id}`),
  bulkMedia:       (ids: number[], action: string) => req<any>("POST", "/media/bulk", { ids, action }),

  // Healer
  healerScan:    () => req<any>("GET",  "/healer/scan"),
  healerFix:     (type: string) => req<any>("POST", "/healer/fix", { type }),
  healerHistory: () => req<any>("GET",  "/healer/history"),

  // Queue
  queue:           (params?: Record<string, string>) => req<any>("GET",  "/queue?" + new URLSearchParams(params)),
  retryJob:        (id: number) => req<any>("POST", `/queue/${id}/retry`),
  cancelJob:       (id: number) => req<any>("POST", `/queue/${id}/cancel`),
  retryAllFailed:  () => req<any>("POST", "/queue/retry-all-failed"),
  cancelAll:       () => req<any>("POST", "/queue/cancel-all"),
  pauseQueue:      () => req<any>("POST", "/queue/pause"),
  resumeQueue:     () => req<any>("POST", "/queue/resume"),

  // SRR
  srrStatus:        () => req<any>("GET",   "/srr/status"),
  srrRules:         () => req<any>("GET",   "/srr/rules"),
  patchSrrRule:     (ruleId: string, data: any) => req<any>("PATCH",  `/srr/rules/${ruleId}`, data),
  srrHistory:       (page = 1) => req<any>("GET",   `/srr/history?page=${page}`),
  srrRunDetail:     (id: number) => req<any>("GET",  `/srr/history/${id}`),
  srrRunTargeted:   (mediaIds: number[], rules: string[]) => req<any>("POST", "/srr/run-targeted", { mediaIds, rules }),
  srrResolve:       (mediaId: number) => req<any>("POST", "/srr/resolve",  { mediaId }),
  srrRequeue:       (mediaId: number) => req<any>("POST", "/srr/requeue",  { mediaId }),
  srrSchedule:      () => req<any>("GET",   "/srr/schedule"),
  updateSrrSchedule:(data: any) => req<any>("PATCH",  "/srr/schedule", data),

  // Sites
  sites:     () =>             req<any>("GET",    "/sites"),
  addSite:   (data: any) =>    req<any>("POST",   "/sites",     data),
  deleteSite:(id: number) =>   req<any>("DELETE", `/sites/${id}`),

  // Upload
  searchTmdb:    (q: string, type: string) => req<any>("POST", "/upload/search-tmdb", { q, type }),
  uploadInit:    (data: any) =>               req<any>("POST", "/upload/init",         data),
  uploadComplete:(id: number, checksum: string) => req<any>("POST", "/upload/complete", { id, checksum }),
};