import { create } from "zustand";
import { api } from "../api/client";

interface AuthState {
  authed: boolean;
  loading: boolean;
  setAuthed: (v: boolean) => void;
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  authed: false,
  loading: true,
  setAuthed: (v) => set({ authed: v }),
  checkAuth: async () => {
    try {
      await api.checkAuth();
      set({ authed: true, loading: false });
    } catch {
      set({ authed: false, loading: false });
    }
  },
  logout: async () => {
    await api.logout().catch(() => {});
    set({ authed: false });
    window.location.href = "/0x/";
  },
}));