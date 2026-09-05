import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSRRStore } from "../store/srrStore";
import { Btn, Badge, SectionHeader, toast, Card, timeAgo } from "../components/common";
import styles from "./SRRPage.module.css";

const DEFAULT_RULES = [
  { id: "zombie-files",      label: "Zombie Downloads",    desc: "Files stuck downloading with no active queue job",          enabled: true },
  { id: "ghost-files",       label: "Ghost Files",         desc: "DB says complete but file missing/empty on disk",           enabled: true },
  { id: "stale-resolving",   label: "Stale Resolving",     desc: "Media stuck in resolving > 1h",                            enabled: true },
  { id: "stale-parts",       label: "Stale Temp Files",    desc: ".part files > 48h old with no active job",                 enabled: true },
  { id: "quality-upgrade",   label: "Quality Upgrades",    desc: "Media with only 720p — try for 1080p",                    enabled: true },
  { id: "exhausted-queue",   label: "Exhausted Queue",     desc: "Queue items at max_attempts — reset for retry",            enabled: true },
  { id: "ghost-pending",     label: "Ghost Pending Queue", desc: "Queue entries stuck as pending (invisible to scheduler)",  enabled: true },
  { id: "stuck-downloading", label: "Stuck Downloading",   desc: "Media marked downloading with all files already complete", enabled: true },
  { id: "failed-retry",      label: "Failed Media Retry",  desc: "Media in failed state after 6h cooldown",                  enabled: true },
  { id: "orphan-cleanup",    label: "Orphan Cleanup",      desc: "Delete disk files with no DB record (destructive)",        enabled: false },
];

export function SRRPage() {
  const { status, liveLines, lastResult } = useSRRStore();
  const [srrInfo, setSrrInfo] = useState<any>(null);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [history, setHistory] = useState<any[]>([]);
  const [histPage, setHistPage] = useState(1);
  const [detailRun, setDetailRun] = useState<any>(null);
  const [tab, setTab] = useState<"rules" | "target" | "history">("rules");
  const [schedule, setSchedule] = useState({ interval: "6h", runOnStartup: true });
  const [targetSearch, setTargetSearch] = useState("");
  const [targetResults, setTargetResults] = useState<any[]>([]);
  const [targetSelected, setTargetSelected] = useState<any>(null);

  useEffect(() => {
    api.srrStatus().then(setSrrInfo).catch(() => {});
    api.srrHistory(histPage).then((r) => setHistory(r.items ?? [])).catch(() => {});
    api.srrSchedule().then((r) => {
      if (r) setSchedule({ interval: r.interval ?? "6h", runOnStartup: r.runOnStartup ?? true });
    }).catch(() => {});
  }, [histPage]);

  const toggleRule = async (ruleId: string, enabled: boolean) => {
    setRules((prev) => prev.map((r) => r.id === ruleId ? { ...r, enabled } : r));
    await api.patchSrrRule(ruleId, { enabled }).catch(() => {});
  };

  const runNow = async () => {
    try {
      await api.triggerSRR();
      toast("SRR started — watch Live Feed below", "info");
    } catch (e: any) { toast(e.message, "error"); }
  };

  const runTargeted = async (action: string) => {
    if (!targetSelected) return;
    try {
      if (action === "resolve") {
        await api.srrResolve(targetSelected.id);
        toast("Force re-resolve triggered", "success");
      } else if (action === "requeue") {
        await api.srrRequeue(targetSelected.id);
        toast("Force requeue triggered", "success");
      } else if (action === "run") {
        await api.srrRunTargeted([targetSelected.id], ["all"]);
        toast("Targeted SRR run started", "info");
      } else if (action === "pending") {
        await api.patchMediaStatus(targetSelected.id, "pending");
        toast("Reset to pending", "success");
      } else if (action === "ready") {
        await api.patchMediaStatus(targetSelected.id, "ready");
        toast("Marked as ready", "success");
      }
    } catch (e: any) { toast(e.message, "error"); }
  };

  const searchTarget = async (q: string) => {
    setTargetSearch(q);
    if (q.length < 2) { setTargetResults([]); return; }
    const r = await api.media({ q, limit: "8" }).catch(() => ({ items: [] }));
    setTargetResults(r.items ?? []);
  };

  const openRunDetail = async (id: number) => {
    const r = await api.srrRunDetail(id).catch(() => null);
    if (r) setDetailRun(r);
  };

  const updateSchedule = async () => {
    await api.updateSrrSchedule(schedule).catch(() => {});
    toast("Schedule updated", "success");
  };

  return (
    <div className={styles.page}>
      {/* Status Bar */}
      <div className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={`${styles.statusDot} ${status === "running" ? styles.running : styles.idle}`} />
          <span className={styles.statusLabel}>{status === "running" ? "Running..." : "Idle"}</span>
          {srrInfo?.lastRun && <span className={styles.statusMeta}>Last: {timeAgo(srrInfo.lastRun)}</span>}
          {srrInfo?.nextRun && <span className={styles.statusMeta}>Next: {timeAgo(srrInfo.nextRun)}</span>}
          {lastResult && (
            <span className={styles.statusMeta}>
              Last result: <span style={{ color: "var(--success)" }}>{lastResult.fixed} fixed</span> / {lastResult.found} found ({(lastResult.durationMs/1000).toFixed(1)}s)
            </span>
          )}
        </div>
        <Btn variant="primary" loading={status === "running"} onClick={runNow}>
          {status === "running" ? "Running..." : "⟳ Run Now"}
        </Btn>
      </div>

      <div className={styles.tabs}>
        {(["rules","target","history"] as const).map((t) => (
          <button key={t} className={`${styles.tab} ${tab === t ? styles.activeTab : ""}`} onClick={() => setTab(t)}>
            {t === "rules" ? "Heal Rules" : t === "target" ? "Target Specific" : "Run History"}
          </button>
        ))}
      </div>

      {/* Rules Panel */}
      {tab === "rules" && (
        <div className={styles.rulesGrid}>
          {rules.map((rule) => (
            <Card key={rule.id} className={`${styles.ruleCard} ${rule.enabled ? styles.ruleOn : styles.ruleOff}`}>
              <div className={styles.ruleHeader}>
                <div>
                  <p className={styles.ruleName}>{rule.label}</p>
                  <p className={styles.ruleDesc}>{rule.desc}</p>
                </div>
                <button
                  className={`${styles.toggle} ${rule.enabled ? styles.toggleOn : styles.toggleOff}`}
                  onClick={() => toggleRule(rule.id, !rule.enabled)}
                  title={rule.enabled ? "Disable" : "Enable"}
                >
                  <span className={styles.toggleThumb} />
                </button>
              </div>
            </Card>
          ))}
          {/* Schedule config */}
          <Card className={styles.schedCard}>
            <p className={styles.ruleName}>Run Schedule</p>
            <div className={styles.schedRow}>
              <select
                className={styles.schedSelect}
                value={schedule.interval}
                onChange={(e) => setSchedule((s) => ({ ...s, interval: e.target.value }))}
              >
                {["1h","2h","4h","6h","12h","24h"].map((v) => <option key={v} value={v}>Every {v}</option>)}
              </select>
              <label className={styles.checkLabel}>
                <input type="checkbox" checked={schedule.runOnStartup}
                  onChange={(e) => setSchedule((s) => ({ ...s, runOnStartup: e.target.checked }))} />
                Run on startup
              </label>
              <Btn small onClick={updateSchedule}>Apply</Btn>
            </div>
          </Card>
        </div>
      )}

      {/* Target Specific */}
      {tab === "target" && (
        <div className={styles.targetSection}>
          <Card>
            <SectionHeader title="Target Specific Media" />
            <input
              className={styles.targetSearch}
              placeholder="Search movie or TV show..."
              value={targetSearch}
              onChange={(e) => searchTarget(e.target.value)}
            />
            {targetResults.length > 0 && (
              <div className={styles.targetResults}>
                {targetResults.map((m: any) => (
                  <div
                    key={m.id}
                    className={`${styles.targetResult} ${targetSelected?.id === m.id ? styles.targetSelected : ""}`}
                    onClick={() => { setTargetSelected(m); setTargetResults([]); setTargetSearch(m.title); }}
                  >
                    <span>{m.title}</span>
                    <span className={styles.targetMeta}>{m.year} · <Badge status={m.status} /></span>
                  </div>
                ))}
              </div>
            )}
            {targetSelected && (
              <div className={styles.targetChosen}>
                <div className={styles.targetInfo}>
                  <span className={styles.targetTitle}>{targetSelected.title}</span>
                  <div className={styles.targetMetas}>
                    <Badge status={targetSelected.type} />
                    <Badge status={targetSelected.status} />
                    <span className={styles.targetMeta}>{targetSelected.year}</span>
                    <span className={styles.targetMeta}>TMDB: {targetSelected.tmdb_id}</span>
                  </div>
                </div>
                <div className={styles.targetActions}>
                  <Btn onClick={() => runTargeted("resolve")}>⟳ Force Re-resolve</Btn>
                  <Btn onClick={() => runTargeted("requeue")}>↓ Force Requeue</Btn>
                  <Btn onClick={() => runTargeted("run")}>✦ Run All Rules</Btn>
                  <Btn variant="secondary" onClick={() => runTargeted("pending")}>Reset to Pending</Btn>
                  <Btn variant="secondary" onClick={() => runTargeted("ready")}>Mark Ready</Btn>
                </div>
                <p className={styles.targetHint}>Select an action to apply SRR operations to this specific title only.</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* History */}
      {tab === "history" && (
        <Card>
          <table className={styles.table}>
            <thead>
              <tr><th>#</th><th>Type</th><th>Target</th><th>Time</th><th>Found</th><th>Fixed</th><th>Duration</th><th></th></tr>
            </thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={8} className={styles.empty}>No SRR history yet</td></tr>}
              {history.map((h: any) => (
                <tr key={h.id}>
                  <td className={styles.histId}>#{h.id}</td>
                  <td><Badge status={h.run_type} /></td>
                  <td>{h.target_title || <span className={styles.muted}>Full scan</span>}</td>
                  <td className={styles.muted}>{timeAgo(h.started_at)}</td>
                  <td style={{ color: h.issues_found > 0 ? "var(--warning)" : "var(--muted)" }}>{h.issues_found}</td>
                  <td style={{ color: h.issues_fixed > 0 ? "var(--success)" : "var(--muted)" }}>{h.issues_fixed}</td>
                  <td className={styles.mono}>{h.duration_ms ? (h.duration_ms/1000).toFixed(1)+"s" : "—"}</td>
                  <td><Btn small variant="ghost" onClick={() => openRunDetail(h.id)}>Detail</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.histPager}>
            <Btn small disabled={histPage <= 1} onClick={() => setHistPage(p => p-1)}>← Prev</Btn>
            <span>Page {histPage}</span>
            <Btn small disabled={history.length < 20} onClick={() => setHistPage(p => p+1)}>Next →</Btn>
          </div>
        </Card>
      )}

      {/* Live Feed */}
      <Card className={styles.liveFeed}>
        <div className={styles.liveFeedHeader}>
          <span className={styles.ruleName}>Live Feed</span>
          {status === "running" && (
            <span className={styles.liveIndicator}>● LIVE</span>
          )}
        </div>
        <div className={styles.terminal}>
          {liveLines.length === 0
            ? <span className={styles.termMuted}>Waiting for SRR run... click Run Now to start.</span>
            : liveLines.map((line, i) => (
              <div key={i} className={`${styles.termLine} ${line.includes("Fixed") || line.includes("✓") ? styles.termSuccess : line.includes("Error") ? styles.termError : ""}`}>
                {line}
              </div>
            ))
          }
        </div>
      </Card>

      {/* Run detail modal */}
      {detailRun && (
        <div className={styles.detailOverlay} onClick={() => setDetailRun(null)}>
          <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.detailHeader}>
              <span>SRR Run #{detailRun.id}</span>
              <button onClick={() => setDetailRun(null)}>✕</button>
            </div>
            <div className={styles.detailBody}>
              <pre className={styles.detailPre}>
                {JSON.stringify(JSON.parse(detailRun.details || "[]"), null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
