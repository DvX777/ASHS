import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Btn, SectionHeader, Badge, toast, Card, timeAgo } from "../components/common";
import styles from "./HealerPage.module.css";

export function HealerPage() {
  const [scan, setScan] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [tab, setTab] = useState<"scan" | "history">("scan");

  const runScan = async () => {
    setScanning(true);
    try {
      const r = await api.healerScan();
      setScan(r);
    } catch (e: any) { toast(e.message, "error"); }
    finally { setScanning(false); }
  };

  const fix = async (type: string) => {
    setFixing(type);
    try {
      const r = await api.healerFix(type);
      toast(`Fixed ${r.fixed} issue(s)`, "success");
      runScan();
    } catch (e: any) { toast(e.message, "error"); }
    finally { setFixing(null); }
  };

  const loadHistory = async () => {
    const r = await api.healerHistory().catch(() => ({ items: [] }));
    setHistory(r.items ?? []);
  };

  useEffect(() => { runScan(); loadHistory(); }, []);

  const hasIssues = scan?.issues?.some((i: any) => i.count > 0);

  const SEVERITY: Record<string, string> = {
    "stuck-downloading": "warning",
    "exhausted-queue": "warning",
    "ghost-pending-queue": "warning",
    "ghost-files": "error",
    "stale-resolving": "warning",
    "failed-media": "failed",
    "orphan-temp": "downloading",
    "orphan-disk-files": "failed",
  };

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Database Healer"
        action={
          <div className={styles.actions}>
            <Btn small variant="secondary" loading={scanning} onClick={runScan}>Scan Now</Btn>
            {hasIssues && <Btn small variant="primary" loading={fixing === "all"} onClick={() => fix("all")}>Fix All Issues</Btn>}
          </div>
        }
      />

      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === "scan" ? styles.activeTab : ""}`} onClick={() => setTab("scan")}>Scan Results</button>
        <button className={`${styles.tab} ${tab === "history" ? styles.activeTab : ""}`} onClick={() => setTab("history")}>History</button>
      </div>

      {tab === "scan" && (
        <div className={styles.issueGrid}>
          {scanning && <p className={styles.scanning}>Scanning system...</p>}
          {!scanning && !scan && <p className={styles.empty}>Click "Scan Now" to check for issues</p>}
          {scan?.issues?.map((issue: any) => (
            <Card key={issue.type} className={`${styles.issueCard} ${issue.count > 0 ? styles[SEVERITY[issue.type] ?? "warning"] : styles.ok}`}>
              <div className={styles.issueTop}>
                <div>
                  <p className={styles.issueName}>{issue.label}</p>
                  <p className={styles.issueDesc}>{issue.description}</p>
                </div>
                <div className={styles.issueCount} style={{ color: issue.count > 0 ? "var(--warning)" : "var(--success)" }}>
                  {issue.count > 0 ? issue.count : "✓"}
                </div>
              </div>
              {issue.count > 0 && (
                <div className={styles.issueAction}>
                  <p className={styles.fixPreview}>{issue.fix_preview}</p>
                  <Btn small variant="primary" loading={fixing === issue.type} onClick={() => fix(issue.type)}>Fix</Btn>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {tab === "history" && (
        <Card>
          <table className={styles.table}>
            <thead>
              <tr><th>Time</th><th>Type</th><th>Target</th><th>Found</th><th>Fixed</th><th>Duration</th></tr>
            </thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={6} className={styles.empty}>No healer history</td></tr>}
              {history.map((h: any) => (
                <tr key={h.id}>
                  <td>{timeAgo(h.started_at)}</td>
                  <td><Badge status={h.run_type} /></td>
                  <td>{h.target_title || "—"}</td>
                  <td style={{ color: h.issues_found > 0 ? "var(--warning)" : "var(--muted)" }}>{h.issues_found}</td>
                  <td style={{ color: h.issues_fixed > 0 ? "var(--success)" : "var(--muted)" }}>{h.issues_fixed}</td>
                  <td style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: "12px" }}>
                    {h.duration_ms ? (h.duration_ms / 1000).toFixed(1) + "s" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}