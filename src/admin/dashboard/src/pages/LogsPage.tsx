import { useEffect, useState } from "react";
import { api } from "../api/client";
import { Btn, SectionHeader, Card } from "../components/common";
import styles from "./LogsPage.module.css";

type LogTab = "out" | "error" | "access";

export function LogsPage() {
  const [tab, setTab] = useState<LogTab>("out");
  const [lines, setLines] = useState<string[]>([]);
  const [access, setAccess] = useState<any[]>([]);
  const [lineCount, setLineCount] = useState(200);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const loadLogs = async () => {
    if (tab === "access") {
      const r = await api.get<any>("/system/logs?type=access&lines=100").catch(() => ({ items: [] }));
      setAccess((r as any).items ?? []);
    } else {
      const r = await api.logs(tab, lineCount);
      setLines(r.lines ?? []);
    }
  };

  useEffect(() => { loadLogs(); }, [tab, lineCount]);
  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(loadLogs, 3000);
    return () => clearInterval(iv);
  }, [autoRefresh, tab]);

  const colorLine = (line: string) => {
    if (line.includes("ERROR")) return styles.lineError;
    if (line.includes("WARN"))  return styles.lineWarn;
    if (line.includes("INFO"))  return styles.lineInfo;
    return "";
  };

  return (
    <div className={styles.page}>
      <SectionHeader
        title="Logs"
        action={
          <div className={styles.actions}>
            <label className={styles.autoLabel}>
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Auto-refresh (3s)
            </label>
            <Btn small onClick={loadLogs}>Refresh</Btn>
          </div>
        }
      />
      <div className={styles.tabs}>
        {(["out","error","access"] as LogTab[]).map((t) => (
          <button key={t} className={`${styles.tab} ${tab === t ? styles.activeTab : ""}`} onClick={() => setTab(t)}>
            {t === "out" ? "App Logs" : t === "error" ? "Error Logs" : "Access Logs"}
          </button>
        ))}
        {tab !== "access" && (
          <select className={styles.lineSelect} value={lineCount} onChange={(e) => setLineCount(Number(e.target.value))}>
            {[100,200,500,1000].map((n) => <option key={n} value={n}>Last {n} lines</option>)}
          </select>
        )}
      </div>

      {tab !== "access" && (
        <Card className={styles.terminal}>
          {lines.length === 0 && <span className={styles.muted}>No log output</span>}
          {lines.map((line, i) => (
            <div key={i} className={`${styles.termLine} ${colorLine(line)}`}>{line}</div>
          ))}
        </Card>
      )}

      {tab === "access" && (
        <Card>
          <table className={styles.table}>
            <thead>
              <tr><th>Method</th><th>Path</th><th>Status</th><th>Time</th><th>Bytes</th><th>When</th></tr>
            </thead>
            <tbody>
              {access.map((l: any) => (
                <tr key={l.id}>
                  <td className={styles.method}>{l.method}</td>
                  <td className={styles.path}>{l.path}</td>
                  <td style={{ color: l.status_code < 400 ? "var(--success)" : "var(--error)" }}>{l.status_code}</td>
                  <td className={styles.muted}>{l.response_ms}ms</td>
                  <td className={styles.muted}>{l.bytes_sent ? (l.bytes_sent/1024).toFixed(0)+"KB" : "—"}</td>
                  <td className={styles.muted}>{l.created_at?.slice(11,19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}