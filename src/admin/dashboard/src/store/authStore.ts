import { create } from "zustand";
import { api, onUnauthorized } from "../api/client";

interface AuthState {
  authed: boolean;
  loading: boolean;
  setAuthed: (v: boolean) => void;
  checkAuth: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => {
  // When ANY protected API call returns 401, drop auth state immediately
  onUnauthorized(() => set({ authed: false, loading: false }));

  return {
    authed:  false,
    loading: true,

    setAuthed: (v) => set({ authed: v, loading: false }),

    checkAuth: async () => {
      set({ loading: true });
      try {
        await api.checkAuth(); // silent401 — never fires notifyUnauthorized
        set({ authed: true, loading: false });
      } catch {
        set({ authed: false, loading: false });
      }
    },

    logout: async () => {
      try { await api.logout(); } catch {}
      set({ authed: false });
    },
  };
});