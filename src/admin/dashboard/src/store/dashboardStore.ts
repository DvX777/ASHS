import { create } from "zustand";
import { api } from "../api/client";

interface DashState {
  stats: any | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useDashStore = create<DashState>((set) => ({
  stats: null,
  loading: false,
  refresh: async () => {
    set({ loading: true });
    try {
      const stats = await api.health();
      set({ stats, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));