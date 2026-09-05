import { create } from "zustand";
import { api } from "../api/client";

interface Stats {
  uptime_seconds: number;
  tunnel: string;
  memory: { rss: number };
  storage: {
    hdd: { total_bytes: number; used_bytes: number; free_bytes: number };
    nvme: { total_bytes: number; used_bytes: number; free_bytes: number };
  };
  library: { movies: number; tv_shows: number; total_files: number; total_bytes: number; failed_media?: number };
  queue: { active: number; pending: number; failed: number; done: number };
}

interface DashState {
  stats: Stats | null;
  lastRefresh: number;
  refresh: () => Promise<void>;
}

export const useDashStore = create<DashState>((set, get) => ({
  stats:       null,
  lastRefresh: 0,

  refresh: async () => {
    // Debounce: don't refresh if last refresh was < 10 seconds ago
    const now = Date.now();
    if (now - get().lastRefresh < 10_000) return;
    try {
      const stats = await api.health();
      set({ stats, lastRefresh: Date.now() });
    } catch {
      // Silently ignore — auth store handles 401s
    }
  },
}));