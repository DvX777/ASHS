import { create } from "zustand";

interface QueueState {
  active: number;
  pending: number;
  failed: number;
  done: number;
  activeJobs: Record<number, { title: string; quality: number; percent: number; speed: number; eta: number }>;
  setStats: (s: { active: number; pending: number; failed: number; done: number }) => void;
  setJobProgress: (jobId: number, data: any) => void;
  removeJob: (jobId: number) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  active: 0, pending: 0, failed: 0, done: 0,
  activeJobs: {},
  setStats: (s) => set(s),
  setJobProgress: (jobId, data) =>
    set((state) => ({ activeJobs: { ...state.activeJobs, [jobId]: data } })),
  removeJob: (jobId) =>
    set((state) => {
      const jobs = { ...state.activeJobs };
      delete jobs[jobId];
      return { activeJobs: jobs };
    }),
}));