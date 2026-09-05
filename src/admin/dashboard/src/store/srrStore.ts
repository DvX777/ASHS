import { create } from "zustand";

interface SRRState {
  status: "idle" | "running";
  runId: number | null;
  liveLines: string[];
  lastResult: { found: number; fixed: number; durationMs: number } | null;
  addLine: (line: string) => void;
  setRunning: (runId: number) => void;
  setComplete: (result: { found: number; fixed: number; durationMs: number }) => void;
  clearLines: () => void;
}

export const useSRRStore = create<SRRState>((set) => ({
  status: "idle",
  runId: null,
  liveLines: [],
  lastResult: null,
  addLine: (line) => set((s) => ({ liveLines: [...s.liveLines.slice(-200), line] })),
  setRunning: (runId) => set({ status: "running", runId, liveLines: [] }),
  setComplete: (result) => set({ status: "idle", lastResult: result }),
  clearLines: () => set({ liveLines: [] }),
}));