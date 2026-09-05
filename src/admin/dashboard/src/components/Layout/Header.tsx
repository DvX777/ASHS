import { useDashStore } from "../../store/dashboardStore";
import { useQueueStore } from "../../store/queueStore";
import styles from "./Header.module.css";

function fmt(bytes: number): string {
  if (bytes > 1e12) return (bytes/1e12).toFixed(1)+" TB";
  if (bytes > 1e9)  return (bytes/1e9).toFixed(1)+" GB";
  if (bytes > 1e6)  return (bytes/1e6).toFixed(0)+" MB";
  return bytes+" B";
}

export function Header({ title }: { title: string }) {
  const stats = useDashStore((s) => s.stats);
  const { active, pending } = useQueueStore();

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <div className={styles.indicators}>
        {active > 0 && (
          <div className={styles.pill} style={{ background: "rgba(93,184,166,0.12)", color: "var(--accent-teal)" }}>
            <span className={styles.dot} style={{ background: "var(--accent-teal)" }} />
            {active} downloading
          </div>
        )}
        {pending > 0 && (
          <div className={styles.pill} style={{ background: "rgba(212,160,23,0.12)", color: "var(--warning)" }}>
            {pending} queued
          </div>
        )}
        {stats?.storage && (
          <div className={styles.pill}>
            HDD {fmt(stats.storage.hdd.used_bytes)} / {fmt(stats.storage.hdd.total_bytes)}
          </div>
        )}
        {stats?.tunnel && (
          <div
            className={styles.pill}
            style={{
              color: stats.tunnel === "connected" ? "var(--success)" : "var(--error)",
              background: stats.tunnel === "connected" ? "rgba(93,184,114,0.1)" : "rgba(198,69,69,0.1)",
            }}
          >
            {stats.tunnel === "connected" ? "● Tunnel OK" : "✗ Tunnel Down"}
          </div>
        )}
      </div>
    </header>
  );
}