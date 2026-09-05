import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { Btn, Badge, SectionHeader, fmtBytes, toast, Modal, Card } from "../components/common";
import styles from "./LibraryPage.module.css";

const TMDB_IMG = "https://image.tmdb.org/t/p/w200";

export function LibraryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [view, setView] = useState<"grid" | "table">("table");
  const [detail, setDetail] = useState<any>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { page: String(page), limit: "50" };
      if (search) params.q = search;
      if (status) params.status = status;
      if (type) params.type = type;
      const r = await api.media(params);
      setItems(r.items ?? []);
      setTotal(r.total ?? 0);
    } catch {} finally { setLoading(false); }
  }, [page, search, status, type]);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id: number) => {
    setSelected((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  };

  const bulkAction = async (action: string) => {
    if (!selected.size) return;
    await api.bulkMedia([...selected], action);
    toast(`${action} applied to ${selected.size} items`, "success");
    setSelected(new Set());
    load();
  };

  const openDetail = async (id: number) => {
    const d = await api.mediaDetail(id).catch(() => null);
    if (d) setDetail(d);
  };

  const retry = async (id: number) => {
    await api.retryMedia(id);
    toast("Queued for retry", "success");
    load();
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this media and all files from disk?")) return;
    await api.deleteMedia(id);
    toast("Deleted", "info");
    setDetail(null);
    load();
  };

  const STATUS_OPTS = ["", "ready", "downloading", "failed", "pending", "unavailable"];
  const TYPE_OPTS = ["", "movie", "tv"];

  return (
    <div className={styles.page}>
      <SectionHeader
        title={`Library (${total.toLocaleString()})`}
        action={
          <div className={styles.viewToggle}>
            <button className={view === "table" ? styles.activeView : ""} onClick={() => setView("table")}>≡ Table</button>
            <button className={view === "grid" ? styles.activeView : ""} onClick={() => setView("grid")}>⊞ Grid</button>
          </div>
        }
      />

      {/* Filters */}
      <div className={styles.filters}>
        <input
          className={styles.search}
          placeholder="Search title..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        <select className={styles.select} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUS_OPTS.map((s) => <option key={s} value={s}>{s || "All Status"}</option>)}
        </select>
        <select className={styles.select} value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          {TYPE_OPTS.map((t) => <option key={t} value={t}>{t || "All Types"}</option>)}
        </select>
        <Btn small onClick={() => { setSearch(""); setStatus(""); setType(""); setPage(1); }}>Clear</Btn>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span>{selected.size} selected</span>
          <Btn small variant="primary" onClick={() => bulkAction("mark-ready")}>Mark Ready</Btn>
          <Btn small variant="secondary" onClick={() => bulkAction("retry")}>Retry</Btn>
          <Btn small variant="danger" onClick={() => bulkAction("remove")}>Remove</Btn>
          <Btn small variant="ghost" onClick={() => setSelected(new Set())}>Deselect All</Btn>
        </div>
      )}

      {/* Table View */}
      {view === "table" && (
        <Card>
          <table className={styles.table}>
            <thead>
              <tr>
                <th><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? new Set(items.map(i => i.id)) : new Set())} /></th>
                <th>Title</th><th>Type</th><th>Year</th><th>Status</th><th>Quality</th><th>Size</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className={styles.empty}>Loading...</td></tr>}
              {items.map((m) => (
                <tr key={m.id} className={styles.row} onClick={() => openDetail(m.id)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSelect(m.id)} />
                  </td>
                  <td className={styles.titleCell}>
                    {m.poster_path && <img src={TMDB_IMG + m.poster_path} className={styles.thumb} alt="" />}
                    <span>{m.title}</span>
                  </td>
                  <td><Badge status={m.type} /></td>
                  <td>{m.year}</td>
                  <td><Badge status={m.status} /></td>
                  <td className={styles.qualCell}>{m.qualities?.join(" + ") ?? "—"}</td>
                  <td>{m.total_size ? fmtBytes(m.total_size) : "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className={styles.rowActions}>
                      {m.status !== "ready" && <Btn small onClick={() => retry(m.id)}>Retry</Btn>}
                      <Btn small variant="danger" onClick={() => remove(m.id)}>Del</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Grid View */}
      {view === "grid" && (
        <div className={styles.grid}>
          {items.map((m) => (
            <div key={m.id} className={styles.gridCard} onClick={() => openDetail(m.id)}>
              <div className={styles.posterWrap}>
                {m.poster_path
                  ? <img src={TMDB_IMG + m.poster_path} className={styles.poster} alt={m.title} />
                  : <div className={styles.noPoster}>{m.title[0]}</div>
                }
                <div className={styles.posterOverlay}>
                  <Badge status={m.status} />
                </div>
              </div>
              <div className={styles.gridInfo}>
                <p className={styles.gridTitle}>{m.title}</p>
                <p className={styles.gridYear}>{m.year}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div className={styles.pagination}>
        <Btn small disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</Btn>
        <span>Page {page} of {Math.ceil(total / 50) || 1}</span>
        <Btn small disabled={page * 50 >= total} onClick={() => setPage(p => p + 1)}>Next →</Btn>
      </div>

      {/* Detail Modal */}
      {detail && (
        <Modal title={detail.title} onClose={() => setDetail(null)}>
          <div className={styles.detail}>
            <div className={styles.detailMeta}>
              <Badge status={detail.status} />
              <Badge status={detail.type} />
              <span>{detail.year}</span>
              <span>⭐ {detail.vote_average?.toFixed(1)}</span>
            </div>
            {detail.overview && <p className={styles.overview}>{detail.overview}</p>}
            <h3 className={styles.filesTitle}>Files ({detail.files?.length ?? 0})</h3>
            <div className={styles.filesList}>
              {detail.files?.map((f: any) => (
                <div key={f.id} className={styles.fileRow}>
                  <span className={styles.fileQual}>{f.quality}p {f.language}</span>
                  <span>{fmtBytes(f.file_size)}</span>
                  <Badge status={f.status} />
                </div>
              ))}
            </div>
            <div className={styles.detailActions}>
              <Btn variant="primary" onClick={() => { retry(detail.id); setDetail(null); }}>Retry / Requeue</Btn>
              <Btn variant="danger" onClick={() => remove(detail.id)}>Remove from Library</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}