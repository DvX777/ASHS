import { useState, useEffect } from "react";
import { api } from "../api/client";
import { Card, SectionHeader, Btn, ProgressBar, toast } from "../components/common";
import styles from "./RadarrPage.module.css";

export function RadarrPage() {
  const [status, setStatus] = useState<any>({ online: false });
  const [queue, setQueue] = useState<any>({ activeCount: 0, maxSlots: 20, records: [] });
  const [, setLoading] = useState(true);
  const [movieIdInput, setMovieIdInput] = useState("");
  const [releases, setReleases] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const fetchStatus = async () => {
    try {
      const s = await api.radarrStatus().catch(() => ({ online: false }));
      const q = await api.radarrQueue().catch(() => ({ activeCount: 0, maxSlots: 20, records: [] }));
      setStatus(s);
      setQueue(q);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSearch = async () => {
    const id = parseInt(movieIdInput.trim(), 10);
    if (!id) {
      toast("Please enter a valid Radarr movie ID", "error");
      return;
    }
    setSearching(true);
    try {
      const res = await api.radarrSearch(id);
      setReleases(res.releases ?? []);
      toast(`Found ${res.releases?.length ?? 0} releases across indexers`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSearching(false);
    }
  };

  const handleGrab = async (guid: string, indexerId: number) => {
    try {
      await api.radarrGrab(guid, indexerId);
      toast("Release sent to qBittorrent!", "success");
      fetchStatus();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  return (
    <div className={styles.page}>
      <SectionHeader title="Radarr 6.3.0 Command Center" />

      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Radarr Engine Status</span>
          <div className={styles.statVal}>
            {status.online ? (
              <>
                <span>v{status.version ?? "6.3.0"}</span>
                <span className={styles.badgeOnline}>Connected</span>
              </>
            ) : (
              <>
                <span>Offline</span>
                <span className={styles.badgeOffline}>Connecting</span>
              </>
            )}
          </div>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statLabel}>Active qBittorrent Downloads</span>
          <div className={styles.statVal}>
            <span>{queue.activeCount} / {queue.maxSlots} Slots</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statLabel}>Storage Architecture</span>
          <div className={styles.statVal} style={{ fontSize: "16px" }}>
            <span>Direct 21TB HDD (/media/.downloads)</span>
          </div>
        </div>
      </div>

      <Card>
        <h3 className={styles.sectionTitle}>Active Download Queue (qBittorrent)</h3>
        {queue.records?.length === 0 ? (
          <p style={{ color: "var(--muted)", padding: "16px 0" }}>
            No active downloads currently running in qBittorrent. All {queue.maxSlots} slots available.
          </p>
        ) : (
          <table className={styles.queueTable}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Client</th>
                <th>Status</th>
                <th>Size</th>
                <th>Progress</th>
                <th>Time Left</th>
              </tr>
            </thead>
            <tbody>
              {queue.records.map((r: any) => {
                const total = r.size || 1;
                const left = r.sizeleft || 0;
                const pct = Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));
                return (
                  <tr key={r.id}>
                    <td><strong>{r.title}</strong></td>
                    <td>{r.downloadClient ?? "qBittorrent"}</td>
                    <td><span className={styles.badgeOnline}>{r.status}</span></td>
                    <td>{(total / (1024 * 1024 * 1024)).toFixed(2)} GB</td>
                    <td style={{ minWidth: "120px" }}>
                      <ProgressBar value={pct} />
                    </td>
                    <td>{r.timeleft ?? "Calculating..."}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h3 className={styles.sectionTitle}>Manual Release Search (Multi-Indexer)</h3>
        <p style={{ color: "var(--muted)", fontSize: "13px", marginBottom: "16px" }}>
          Inspect real-time releases across Prowlarr/Torznab indexers and manually grab any release directly to qBittorrent.
        </p>
        <div className={styles.searchBar}>
          <input
            className={styles.searchInput}
            placeholder="Enter Radarr Movie ID to search releases..."
            value={movieIdInput}
            onChange={(e) => setMovieIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <Btn variant="primary" onClick={handleSearch} disabled={searching}>
            {searching ? "Searching..." : "Search Indexers"}
          </Btn>
        </div>

        {releases.length > 0 && (
          <div className={styles.releaseList}>
            {releases.map((rel: any) => (
              <div key={rel.guid} className={styles.releaseItem}>
                <div>
                  <strong>{rel.title}</strong>
                  <div className={styles.releaseMeta}>
                    <span>Indexer: {rel.indexer}</span>
                    <span>Size: {(rel.size / (1024 * 1024 * 1024)).toFixed(2)} GB</span>
                    <span>Seeds: {rel.seeders ?? 0}</span>
                    <span>Quality: {rel.quality?.quality?.name ?? "1080p"}</span>
                  </div>
                </div>
                <Btn variant="secondary" onClick={() => handleGrab(rel.guid, rel.indexerId)}>
                  Grab Release
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
