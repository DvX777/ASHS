import { useState, useEffect } from "react";
import { api } from "../api/client";
import { Card, SectionHeader, Btn, ProgressBar, toast } from "../components/common";
import styles from "./RadarrPage.module.css";

export function RadarrPage() {
  const [status, setStatus] = useState<any>({ online: false });
  const [queue, setQueue] = useState<any>({ activeCount: 0, maxSlots: 20, records: [] });
  const [downloaded, setDownloaded] = useState<any[]>([]);
  const [loadingDownloaded, setLoadingDownloaded] = useState(false);
  const [, setLoading] = useState(true);

  // Search filter for downloaded library
  const [downloadedSearch, setDownloadedSearch] = useState("");

  // Add Movie via TMDB
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchingTmdb, setSearchingTmdb] = useState(false);

  // Manual Release Search
  const [movieIdInput, setMovieIdInput] = useState("");
  const [releases, setReleases] = useState<any[]>([]);
  const [searchingReleases, setSearchingReleases] = useState(false);

  // Action busy states
  const [syncingAshs, setSyncingAshs] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [cleaning, setCleaning] = useState(false);

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

  const fetchDownloaded = async () => {
    setLoadingDownloaded(true);
    try {
      const res = await api.radarrDownloaded().catch(() => ({ items: [] }));
      setDownloaded(res.items ?? []);
    } finally {
      setLoadingDownloaded(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchDownloaded();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleSearchTmdb = async () => {
    if (!searchQuery.trim()) return;
    setSearchingTmdb(true);
    try {
      const res = await api.radarrLookup(searchQuery.trim());
      setSearchResults(res.results ?? []);
      if (!res.results?.length) toast("No movies found on TMDB", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSearchingTmdb(false);
    }
  };

  const handleAddMovie = async (m: any) => {
    try {
      await api.radarrAdd(m.tmdbId, m.title);
      toast(`Added "${m.title}" to Radarr! Automatic indexer search started.`, "success");
      setSearchResults(prev => prev.filter(item => item.tmdbId !== m.tmdbId));
      fetchStatus();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const handleSearchReleases = async () => {
    const id = parseInt(movieIdInput.trim(), 10);
    if (!id) {
      toast("Please enter a valid Radarr movie ID", "error");
      return;
    }
    setSearchingReleases(true);
    try {
      const res = await api.radarrSearch(id);
      setReleases(res.releases ?? []);
      toast(`Found ${res.releases?.length ?? 0} releases across indexers`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSearchingReleases(false);
    }
  };

  const handleGrab = async (guid: string, indexerId: number) => {
    try {
      await api.radarrGrab(guid, indexerId);
      toast("Release grabbed and sent to qBittorrent!", "success");
      fetchStatus();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const handleCancelDownload = async (id: number) => {
    try {
      await api.radarrCancelQueue(id);
      toast("Download cancelled from qBittorrent", "info");
      fetchStatus();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const handleSyncAshs = async () => {
    setSyncingAshs(true);
    try {
      await api.radarrImportAshs();
      toast("Syncing all 411 ASHS movies into Radarr in background...", "success");
      setTimeout(fetchDownloaded, 5000);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSyncingAshs(false);
    }
  };

  const handleTriggerDiscovery = async () => {
    setDiscovering(true);
    try {
      await api.radarrTriggerDiscovery();
      toast("TMDB discovery cycle triggered! Top movies will queue into Radarr.", "success");
      setTimeout(fetchStatus, 3000);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setDiscovering(false);
    }
  };

  const handleCleanQueue = async () => {
    setCleaning(true);
    try {
      const res = await api.radarrCleanQueue();
      toast(`Purged ${res.queueDeleted ?? 0} old failed queue items!`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setCleaning(false);
    }
  };

  const filteredDownloaded = downloaded.filter(m => {
    if (!downloadedSearch.trim()) return true;
    return m.title.toLowerCase().includes(downloadedSearch.toLowerCase());
  });

  return (
    <div className={styles.page}>
      <SectionHeader title="Radarr 6.3.0 Command Center" />

      {/* Quick Action Toolbar */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
        <Btn variant="primary" onClick={handleSyncAshs} disabled={syncingAshs}>
          {syncingAshs ? "Syncing..." : "🔄 Sync 411 Movies into Radarr"}
        </Btn>
        <Btn variant="secondary" onClick={handleTriggerDiscovery} disabled={discovering}>
          {discovering ? "Discovering..." : "⚡ Trigger Auto-Discovery Now"}
        </Btn>
        <Btn variant="secondary" onClick={fetchDownloaded} disabled={loadingDownloaded}>
          {loadingDownloaded ? "Refreshing..." : "📂 Refresh Downloaded List"}
        </Btn>
        <Btn variant="danger" onClick={handleCleanQueue} disabled={cleaning}>
          {cleaning ? "Cleaning..." : "🧹 Purge Failed MovieBox Queue"}
        </Btn>
      </div>

      {/* System Status Cards */}
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
          <span className={styles.statLabel}>Radarr Downloaded Library</span>
          <div className={styles.statVal} style={{ fontSize: "18px" }}>
            <span>{downloaded.length} Movies Downloaded</span>
          </div>
        </div>
      </div>

      {/* 1. Add New Movie via TMDB */}
      <Card>
        <h3 className={styles.sectionTitle}>Add New Movie via TMDB (Auto-Search & Download)</h3>
        <p style={{ color: "var(--muted)", fontSize: "13px", marginBottom: "16px" }}>
          Search any movie across TMDB to add it to Radarr. Radarr will immediately search indexers and start downloading the highest quality release via qBittorrent.
        </p>
        <div className={styles.searchBar}>
          <input
            className={styles.searchInput}
            placeholder="Search movie title (e.g. Inception, Dune, Oppenheimer)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearchTmdb()}
          />
          <Btn variant="primary" onClick={handleSearchTmdb} disabled={searchingTmdb}>
            {searchingTmdb ? "Searching..." : "Search TMDB"}
          </Btn>
        </div>

        {searchResults.length > 0 && (
          <div className={styles.releaseList}>
            {searchResults.map((m: any) => (
              <div key={m.tmdbId} className={styles.releaseItem}>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  {m.images?.find((img: any) => img.coverType === "poster")?.remoteUrl && (
                    <img
                      src={m.images.find((img: any) => img.coverType === "poster").remoteUrl}
                      alt=""
                      style={{ width: "45px", height: "65px", objectFit: "cover", borderRadius: "4px" }}
                    />
                  )}
                  <div>
                    <strong>{m.title} ({m.year})</strong>
                    <div className={styles.releaseMeta}>
                      <span>Rating: {m.ratings?.imdb?.value ?? m.ratings?.tmdb?.value ?? "N/A"}</span>
                      <span>Runtime: {m.runtime} min</span>
                      <span>Status: {m.status}</span>
                    </div>
                    <p style={{ fontSize: "12px", color: "var(--body)", marginTop: "4px" }}>
                      {m.overview?.slice(0, 120)}...
                    </p>
                  </div>
                </div>
                <Btn variant="primary" onClick={() => handleAddMovie(m)}>
                  + Add & Download
                </Btn>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 2. Active Download Queue in qBittorrent */}
      <Card>
        <h3 className={styles.sectionTitle}>Live qBittorrent Downloads ({queue.activeCount} Active)</h3>
        {queue.records?.length === 0 ? (
          <p style={{ color: "var(--muted)", padding: "16px 0" }}>
            No active downloads running in qBittorrent. All {queue.maxSlots} slots available. The automatic feeder will dispatch pending movies every 30 seconds.
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
                <th>ETA</th>
                <th>Action</th>
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
                    <td>
                      <Btn small variant="danger" onClick={() => handleCancelDownload(r.id)}>
                        Cancel
                      </Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* 3. Downloaded Movies in Radarr */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" }}>
          <div>
            <h3 className={styles.sectionTitle} style={{ margin: 0 }}>
              Radarr Downloaded Library ({filteredDownloaded.length} of {downloaded.length} Movies)
            </h3>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>
              Movies imported and stored on the 21TB HDD (/media/Movies)
            </span>
          </div>
          <input
            className={styles.searchInput}
            style={{ width: "240px", padding: "6px 12px" }}
            placeholder="Filter downloaded..."
            value={downloadedSearch}
            onChange={(e) => setDownloadedSearch(e.target.value)}
          />
        </div>

        {filteredDownloaded.length === 0 ? (
          <p style={{ color: "var(--muted)", padding: "16px 0" }}>
            {downloaded.length === 0
              ? "No downloaded movies found in Radarr yet. Click 'Sync 411 Movies into Radarr' above to index your existing ASHS library!"
              : "No movies match your filter."}
          </p>
        ) : (
          <div style={{ maxHeight: "450px", overflowY: "auto" }}>
            <table className={styles.queueTable}>
              <thead>
                <tr>
                  <th>Movie</th>
                  <th>Quality</th>
                  <th>Size</th>
                  <th>Path</th>
                </tr>
              </thead>
              <tbody>
                {filteredDownloaded.map((m: any) => {
                  const size = m.movieFile?.size || m.sizeOnDisk || 0;
                  const sizeGb = size > 0 ? (size / (1024 * 1024 * 1024)).toFixed(2) + " GB" : "N/A";
                  const qName = m.movieFile?.quality?.quality?.name ?? "1080p";
                  return (
                    <tr key={m.id}>
                      <td><strong>{m.title} ({m.year})</strong></td>
                      <td><span className={styles.badgeOnline}>{qName}</span></td>
                      <td>{sizeGb}</td>
                      <td style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>
                        {m.movieFile?.relativePath || m.movieFile?.path || "/media/Movies/" + m.title}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 4. Interactive Manual Release Search */}
      <Card>
        <h3 className={styles.sectionTitle}>Manual Release Search (Multi-Indexer)</h3>
        <p style={{ color: "var(--muted)", fontSize: "13px", marginBottom: "16px" }}>
          Inspect releases across indexers and manually pick a specific torrent/quality release to send to qBittorrent.
        </p>
        <div className={styles.searchBar}>
          <input
            className={styles.searchInput}
            placeholder="Enter Radarr Movie ID to search releases..."
            value={movieIdInput}
            onChange={(e) => setMovieIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearchReleases()}
          />
          <Btn variant="secondary" onClick={handleSearchReleases} disabled={searchingReleases}>
            {searchingReleases ? "Searching..." : "Search Indexers"}
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
                    <span style={{ color: (rel.seeders ?? 0) > 10 ? "var(--success)" : "inherit" }}>
                      Seeds: {rel.seeders ?? 0}
                    </span>
                    <span>Quality: {rel.quality?.quality?.name ?? "1080p"}</span>
                  </div>
                </div>
                <Btn variant="primary" onClick={() => handleGrab(rel.guid, rel.indexerId)}>
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
