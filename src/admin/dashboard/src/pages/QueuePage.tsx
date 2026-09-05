import { useEffect, useState } from "react";
import { useQueueStore } from "../store/queueStore";
import { api } from "../api/client";
import { Btn, Badge, ProgressBar, SectionHeader, fmtBytes, toast, Card } from "../components/common";
import styles from "./QueuePage.module.css";

type Tab = "active" | "pending" | "failed" | "done";

export function QueuePage() {
  const [tab, setTab] = useState<Tab>("active");
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const { active, pending, failed, activeJobs } = useQueueStore();
  const [paused, setPaused] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.queue({ status: tab, limit: "100" });
      setJobs(r.jobs ?? []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [tab]);

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
  const COUNTS: Record<Tab, number> = { active, pending, failed, done: 0 };

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
        {/* Active jobs with real-time progress */}
        {tab === "active" && (
          <div className={styles.jobList}>
            {Object.entries(activeJobs).length === 0 && (
              <p className={styles.empty}>No active downloads</p>
            )}
            {Object.entries(activeJobs).map(([id, job]: [string, any]) => (
              <div key={id} className={styles.activeJob}>
                <div className={styles.jobHeader}>
                  <span className={styles.jobTitle}>{job.title}</span>
                  <Badge status={job.quality >= 1080 ? "ready" : "downloading"} />
                  <span className={styles.jobQual}>{job.quality}p</span>
                </div>
                <ProgressBar value={job.percent} />
                <div className={styles.jobMeta}>
                  <span>{job.percent?.toFixed(1)}%</span>
                  {job.speed > 0 && <span>{fmtBytes(job.speed)}/s</span>}
                  {job.eta > 0 && <span>ETA {Math.ceil(job.eta / 60)}m</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Other tabs */}
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
                  <td className={styles.errorCell} title={j.error}>{j.error ? j.error.slice(0, 50) : "—"}</td>
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