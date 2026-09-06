import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Btn, Badge, ProgressBar, SectionHeader, toast, Card } from "../components/common";
import styles from "./QueuePage.module.css";

type Tab = "active" | "pending" | "done" | "failed";

export function QueuePage() {
  const [tab, setTab] = useState<Tab>("active");
  const [jobs, setJobs] = useState<any[]>([]);
  const [radarrQueue, setRadarrQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dispatchingId, setDispatchingId] = useState<number | null>(null);

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

  const handleDispatchNow = async (media: any) => {
    setDispatchingId(media.id);
    try {
      await api.radarrAdd(Number(media.tmdb_id), media.title);
      toast(`Dispatched "${media.title}" to Radarr & qBittorrent!`, "success");
      setJobs(prev => prev.filter(j => j.id !== media.id));
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setDispatchingId(null);
    }
  };

  const retryMedia = async (id: number) => {
    try {
      await api.retryMedia(id);
      toast("Queued for retry", "success");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: "active",  label: "Active Downloads" },
    { key: "pending", label: "Pending Pipeline" },
    { key: "done",    label: "Completed Library" },
    { key: "failed",  label: "Failed" },
  ];

  return (
    <div className={styles.page}>
      <SectionHeader title="Download Queue & Pipeline" />

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.activeTab : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.key === "active" && radarrQueue.length > 0 && (
              <span className={styles.tabBadge}>{radarrQueue.length}</span>
            )}
          </button>
        ))}
      </div>

      <Card>
        {/* 1. Active qBittorrent / Radarr downloads */}
        {tab === "active" && (
          <div className={styles.jobList}>
            {radarrQueue.length === 0 && (
              <p className={styles.empty}>
                No active downloads currently running in qBittorrent. The auto-feeder pulls pending movies every 30 seconds.
              </p>
            )}
            {radarrQueue.map((job: any) => {
              const total = job.size || 0;
              const left = job.sizeleft || 0;
              const isQueued = job.status?.toLowerCase() === "queued" || total === 0;
              const pct = isQueued || total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
              const totalGb = total > 0 ? (total / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "Pending metadata";
              const downloadedGb = total > 0 ? ((total - left) / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "0.00 GB";

              return (
                <div key={job.id} className={styles.activeJob}>
                  <div className={styles.jobHeader}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span className={styles.jobTitle}>{job.title}</span>
                      {job.releaseTitle && job.releaseTitle !== job.title && (
                        <span style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>
                          {job.releaseTitle}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{
                        fontSize: "12px",
                        padding: "3px 8px",
                        borderRadius: "12px",
                        background: isQueued ? "rgba(255,255,255,0.08)" : "rgba(34, 197, 94, 0.15)",
                        color: isQueued ? "var(--muted)" : "#22c55e",
                        fontWeight: 600
                      }}>
                        {isQueued ? "Queued" : "Downloading"}
                      </span>
                      <Btn small variant="danger" onClick={() => cancelRadarrJob(job.id, job.title)}>
                        Cancel
                      </Btn>
                    </div>
                  </div>

                  <ProgressBar value={pct} />

                  <div className={styles.jobMeta}>
                    <span>
                      {isQueued ? "Waiting for slot / fetching metadata" : `${pct}% (${downloadedGb} / ${totalGb})`}
                    </span>
                    {job.timeleft && <span>ETA: {job.timeleft}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 2. Pending Pipeline (Movies waiting for Radarr slots) */}
        {tab === "pending" && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Year</th>
                <th>Popularity</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className={styles.empty}>Loading pending queue...</td></tr>}
              {!loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.empty}>
                    No pending items in queue. Discovery automatically adds trending items.
                  </td>
                </tr>
              )}
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className={styles.titleCell}>
                    <strong>{j.title}</strong>
                  </td>
                  <td>{j.year || "N/A"}</td>
                  <td>{j.popularity ? j.popularity.toFixed(1) : "N/A"}</td>
                  <td>
                    <span style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: "rgba(99, 102, 241, 0.15)",
                      color: "var(--accent)"
                    }}>
                      Waiting for Slot
                    </span>
                  </td>
                  <td>
                    <Btn
                      small
                      variant="primary"
                      onClick={() => handleDispatchNow(j)}
                      disabled={dispatchingId === j.id}
                    >
                      {dispatchingId === j.id ? "Adding..." : "⚡ Download Now"}
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 3. Completed Library (Real downloaded files) */}
        {tab === "done" && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Quality</th>
                <th>Size</th>
                <th>File Path</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className={styles.empty}>Loading completed files...</td></tr>}
              {!loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className={styles.empty}>No completed files found.</td>
                </tr>
              )}
              {jobs.map((j) => {
                const sizeGb = j.file_size ? (j.file_size / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "N/A";
                return (
                  <tr key={j.id}>
                    <td className={styles.titleCell}>
                      <strong>{j.title} {j.year ? `(${j.year})` : ""}</strong>
                    </td>
                    <td>
                      <span style={{
                        fontSize: "11px",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        background: "rgba(34, 197, 94, 0.15)",
                        color: "#22c55e",
                        fontWeight: 600
                      }}>
                        {j.quality ? `${j.quality}p` : "1080p"}
                      </span>
                    </td>
                    <td>{sizeGb}</td>
                    <td style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>
                      {j.file_path || "/media/Movies/" + j.title}
                    </td>
                    <td>
                      <Badge status="ready" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* 4. Failed Items */}
        {tab === "failed" && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Year</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={4} className={styles.empty}>Loading...</td></tr>}
              {!loading && jobs.length === 0 && (
                <tr><td colSpan={4} className={styles.empty}>No failed items! Library is healthy.</td></tr>
              )}
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className={styles.titleCell}><strong>{j.title}</strong></td>
                  <td>{j.year || "N/A"}</td>
                  <td><Badge status="failed" /></td>
                  <td>
                    <Btn small variant="primary" onClick={() => retryMedia(j.id)}>
                      Retry
                    </Btn>
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
