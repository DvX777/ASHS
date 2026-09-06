import { useEffect, useState } from "react";
import { useQueueStore } from "../store/queueStore";
import { api } from "../api/client";
import { Btn, Badge, ProgressBar, SectionHeader, toast, Card } from "../components/common";
import styles from "./QueuePage.module.css";

type Tab = "active" | "pending" | "failed" | "done";

export function QueuePage() {
  const [tab, setTab] = useState<Tab>("active");
  const [jobs, setJobs] = useState<any[]>([]);
  const [radarrQueue, setRadarrQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const { pending, failed } = useQueueStore();
  const [paused, setPaused] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      if (tab === "active") {
        const rq = await api.radarrQueue().catch(() => ({ records: [] }));
        setRadarrQueue(rq.records ?? []);
      } else {
        const r = await api.queue({ status: tab, limit: "100" });
        setJobs(r.jobs ?? []);
      }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (tab === "active") {
        api.radarrQueue().then((rq: any) => setRadarrQueue(rq.records ?? [])).catch(() => {});
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [tab]);

  const cancelRadarrJob = async (id: number, title: string) => {
    if (!confirm(`Cancel download for "${title}"?`)) return;
    try {
      await api.radarrCancelQueue(id);
      toast("Download cancelled and removed from qBittorrent", "info");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const retry = async (id: number) => {
    await api.retryJob(id).catch((e) => toast(e.message, "error"));
    toast("Job re-queued", "success"); load();
  };

  const cancel = async (id: number) => {
    await api.cancelJob(id).catch((e) => toast(e.message, "error"));
    toast("Job cancelled", "info"); load();
  };

  const retryAll = async () => {
    const r = await api.retryAllFailed().catch((e) => { toast(e.message, "error"); return null; });
    if (r) { toast(`Retrying ${r.count} jobs`, "success"); load(); }
  };

  const togglePause = async () => {
    if (paused) { await api.resumeQueue(); toast("Queue resumed", "success"); }
    else { await api.pauseQueue(); toast("Queue paused", "info"); }
    setPaused(!paused);
  };

  const TABS: Tab[] = ["active", "pending", "failed", "done"];
  const COUNTS: Record<Tab, number> = { active: radarrQueue.length, pending, failed, done: 0 };

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Download Queue"
        action={
          <div className={styles.actions}>
            {tab === "failed" && failed > 0 && (
              <Btn small variant="primary" onClick={retryAll}>Retry All Failed</Btn>
            )}
            <Btn small variant={paused ? "primary" : "secondary"} onClick={togglePause}>
              {paused ? "▶ Resume" : "⏸ Pause"}
            </Btn>
          </div>
        }
      />

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t}
            className={`${styles.tab} ${tab === t ? styles.activeTab : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {COUNTS[t] > 0 && <span className={styles.tabBadge}>{COUNTS[t]}</span>}
          </button>
        ))}
      </div>

      <Card>
        {/* Active qBittorrent / Radarr downloads */}
        {tab === "active" && (
          <div className={styles.jobList}>
            {radarrQueue.length === 0 && (
              <p className={styles.empty}>No active downloads running in qBittorrent</p>
            )}
            {radarrQueue.map((job: any) => {
              const total = job.size || 1;
              const left = job.sizeleft || 0;
              const pct = Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
              const totalGb = (total / (1024 * 1024 * 1024)).toFixed(2);
              const downloadedGb = ((total - left) / (1024 * 1024 * 1024)).toFixed(2);

              return (
                <div key={job.id} className={styles.activeJob}>
                  <div className={styles.jobHeader}>
                    <div>
                      <span className={styles.jobTitle}>{job.title}</span>
                      <span style={{ marginLeft: "8px", fontSize: "11px", color: "var(--muted)" }}>
                        via {job.downloadClient ?? "qBittorrent"}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span className={styles.jobQual}>{job.status}</span>
                      <Btn small variant="danger" onClick={() => cancelRadarrJob(job.id, job.title)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>
                  <ProgressBar value={pct} />
                  <div className={styles.jobMeta}>
                    <span>{pct}% ({downloadedGb} GB / {totalGb} GB)</span>
                    {job.timeleft && <span>ETA: {job.timeleft}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Other legacy tabs */}
        {tab !== "active" && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th><th>Quality</th><th>Status</th><th>Attempts</th><th>Error</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className={styles.empty}>Loading...</td></tr>}
              {!loading && jobs.length === 0 && <tr><td colSpan={6} className={styles.empty}>No jobs</td></tr>}
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className={styles.titleCell}>{j.title}</td>
                  <td>{j.quality}p</td>
                  <td><Badge status={j.status} /></td>
                  <td>{j.attempts}/{j.max_attempts}</td>
                  <td className={styles.errorCell} title={j.error}>{j.error ? j.error.slice(0, 50) : "-"}</td>
                  <td>
                    <div className={styles.rowActions}>
                      {tab === "failed" && <Btn small onClick={() => retry(j.id)}>Retry</Btn>}
                      {tab === "pending" && <Btn small variant="danger" onClick={() => cancel(j.id)}>Cancel</Btn>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
